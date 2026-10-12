import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType, Prisma, type ApprovalKind, type ApprovalRequest, type ApprovalRequestStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { BusinessConfigService } from '../../config/business-config.service.js';
import { CursorService } from '../../common/pagination/cursor.service.js';
import { Paginated } from '../../common/pagination/paginated.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { FORBIDDEN, RESOURCE_CONFLICT, RESOURCE_NOT_FOUND } from '../../common/constants/error-codes.js';
import type { AuthenticatedAdmin } from '../decorators/admin-auth.decorator.js';
import type { AdminPermissionKey } from '../admin.permissions.js';
import type { AdminReason } from './admin-reasons.js';
import { AdminActionService, type AdminRequestContext } from './admin-action.service.js';

/** The permission an admin needs to approve each kind. Asking for one needs the kind's own permission too. */
export const APPROVAL_PERMISSION: Record<ApprovalKind, AdminPermissionKey> = {
  PERMANENT_SUSPENSION: 'ENFORCEMENT_APPLY',
  ADMIN_ROLE_CHANGE: 'ADMIN_ACCOUNTS_MANAGE',
  PRICE_CHANGE: 'PRICING_MANAGE',
  KILL_SWITCH: 'FEATURE_FLAGS_MANAGE',
  CONFIG_CHANGE: 'CONFIG_MANAGE',
};

export interface ApprovalContext {
  approvalId: string;
  requestedBy: string;
  approvedBy: string;
  reason: AdminReason;
}

/** What runs when the second admin approves. Registered once per kind by the module that owns the action. */
export interface ApprovalExecutor {
  kind: ApprovalKind;
  /** Run the action through its domain service. The returned object is stored as the result. */
  execute(payload: Record<string, unknown>, ctx: ApprovalContext): Promise<Record<string, unknown> | void>;
}

@Injectable()
export class ApprovalExecutorRegistry {
  private readonly executors = new Map<ApprovalKind, ApprovalExecutor>();

  register(executor: ApprovalExecutor): void {
    this.executors.set(executor.kind, executor);
  }

  get(kind: ApprovalKind): ApprovalExecutor | undefined {
    return this.executors.get(kind);
  }
}

export interface ApprovalView {
  id: string;
  kind: ApprovalKind;
  status: ApprovalRequestStatus;
  requestedBy: string;
  reasonCode: string;
  reasonText: string | null;
  summary: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  decidedBy: string | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  executedAt: Date | null;
  result: Record<string, unknown> | null;
  failureReason: string | null;
  expiresAt: Date;
  createdAt: Date;
  /** True when the signed-in admin may approve or reject it now. */
  canDecide: boolean;
}

/**
 * Four-eyes approval (Backend PRD 24.5). An admin asks; a DIFFERENT admin who holds the kind's
 * approving permission decides. The action runs only on approval, through its own executor and
 * therefore through the same domain service and state machine as any other change.
 *
 * Concurrency: the decision is one conditional UPDATE (`PENDING` only), so two approvers cannot
 * both run the action. A request nobody decides expires after `APPROVAL_EXPIRY_HOURS`.
 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: BusinessConfigService,
    private readonly cursors: CursorService,
    private readonly registry: ApprovalExecutorRegistry,
    private readonly actions: AdminActionService,
  ) {}

  async request(
    admin: AuthenticatedAdmin,
    input: {
      kind: ApprovalKind;
      reason: AdminReason;
      summary: string;
      targetType?: string;
      targetId?: string;
      payload: Record<string, unknown>;
    },
    ctx: AdminRequestContext = {},
  ): Promise<ApprovalView> {
    this.actions.assertReason(input.reason);
    this.requirePermission(admin, APPROVAL_PERMISSION[input.kind]);
    if (!this.registry.get(input.kind)) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'This kind of change cannot be approved here.', details: { kind: input.kind } });
    }
    const hours = await this.config.get('APPROVAL_EXPIRY_HOURS');
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO approval_requests
        (kind, requested_by, reason_code, reason_text, summary, target_type, target_id, payload, expires_at)
      VALUES (${input.kind}::"ApprovalKind", ${admin.adminId}::uuid, ${input.reason.code}, ${input.reason.text ?? null},
              ${input.summary}, ${input.targetType ?? null}, ${input.targetId ?? null},
              ${JSON.stringify(input.payload)}::jsonb, clock_timestamp() + make_interval(hours => ${hours}::int))
      RETURNING id::text
    `;
    await this.audit.record({
      actorType: AuditActorType.ADMIN,
      actorId: admin.adminId,
      action: 'admin.approval.requested',
      entityType: 'approval_request',
      entityId: rows[0].id,
      reasonCode: input.reason.code,
      requestId: ctx.requestId,
      ip: ctx.ip,
      metadata: { kind: input.kind, summary: input.summary, targetType: input.targetType, targetId: input.targetId },
    });
    return this.get(admin, rows[0].id);
  }

  async list(
    admin: AuthenticatedAdmin,
    options: { status?: ApprovalRequestStatus; kind?: ApprovalKind; mine?: boolean; cursor?: string; limit?: number },
  ): Promise<Paginated<ApprovalView>> {
    await this.expireDue();
    const limit = options.limit ?? 20;
    const cursor = options.cursor ? this.cursors.decode(options.cursor) : undefined;
    const kinds = (Object.keys(APPROVAL_PERMISSION) as ApprovalKind[]).filter((kind) => admin.permissions.includes(APPROVAL_PERMISSION[kind]));
    const where: Prisma.ApprovalRequestWhereInput = {
      // An admin sees what they asked for, and what they could decide.
      OR: [{ requestedBy: admin.adminId }, { kind: { in: kinds } }],
      ...(options.mine ? { requestedBy: admin.adminId } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
      ...(cursor
        ? { AND: [{ OR: [{ createdAt: { lt: cursor.createdAt as Date } }, { createdAt: cursor.createdAt as Date, id: { lt: cursor.id } }] }] }
        : {}),
    };
    const rows = await this.prisma.approvalRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return new Paginated(
      page.map((row) => this.view(row, admin)),
      {
        hasNextPage,
        ...(hasNextPage && last
          ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) }
          : {}),
      },
    );
  }

  async get(admin: AuthenticatedAdmin, id: string): Promise<ApprovalView> {
    const row = await this.load(id);
    if (row.requestedBy !== admin.adminId && !admin.permissions.includes(APPROVAL_PERMISSION[row.kind])) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return this.view(row, admin);
  }

  /** Approve and run it. If the action fails the request is FAILED (with the reason) and the view says so. */
  async approve(admin: AuthenticatedAdmin, id: string, note: string | undefined, ctx: AdminRequestContext = {}): Promise<ApprovalView> {
    const row = await this.load(id);
    this.assertCanDecide(admin, row);
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.expireDue();
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'This request has expired.', details: { status: 'EXPIRED' } });
    }
    const executor = this.registry.get(row.kind);
    if (!executor) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'This kind of change cannot be approved here.', details: { kind: row.kind } });
    }

    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE approval_requests
      SET status = 'APPROVED'::"ApprovalRequestStatus", decided_by = ${admin.adminId}::uuid, decision_note = ${note ?? null},
          decided_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = ${id}::uuid AND status = 'PENDING'::"ApprovalRequestStatus" AND expires_at > clock_timestamp()
      RETURNING id::text
    `;
    if (claimed.length === 0) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'This request was already decided.' });
    }

    let outcome: Record<string, unknown> | void;
    try {
      outcome = await executor.execute(row.payload as Record<string, unknown>, {
        approvalId: id,
        requestedBy: row.requestedBy,
        approvedBy: admin.adminId,
        reason: { code: row.reasonCode as AdminReason['code'], text: row.reasonText ?? undefined },
      });
    } catch (error) {
      const reason = error instanceof DomainException ? `${error.code}: ${error.message}` : 'The action failed unexpectedly.';
      this.logger.error(`Approved request ${id} (${row.kind}) failed: ${String(error)}`);
      await this.prisma.$executeRaw`
        UPDATE approval_requests SET status = 'FAILED'::"ApprovalRequestStatus", failure_reason = ${reason}, updated_at = clock_timestamp()
        WHERE id = ${id}::uuid
      `;
      await this.writeDecisionAudit(admin, row, 'admin.approval.failed', ctx, { failure: reason });
      return this.get(admin, id);
    }

    await this.prisma.$executeRaw`
      UPDATE approval_requests
      SET status = 'EXECUTED'::"ApprovalRequestStatus", executed_at = clock_timestamp(), updated_at = clock_timestamp(),
          result = ${outcome ? JSON.stringify(outcome) : null}::jsonb
      WHERE id = ${id}::uuid
    `;
    await this.writeDecisionAudit(admin, row, 'admin.approval.executed', ctx, {});
    return this.get(admin, id);
  }

  async reject(admin: AuthenticatedAdmin, id: string, note: string | undefined, ctx: AdminRequestContext = {}): Promise<ApprovalView> {
    const row = await this.load(id);
    this.assertCanDecide(admin, row);
    const claimed = await this.prisma.$executeRaw`
      UPDATE approval_requests
      SET status = 'REJECTED'::"ApprovalRequestStatus", decided_by = ${admin.adminId}::uuid, decision_note = ${note ?? null},
          decided_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = ${id}::uuid AND status = 'PENDING'::"ApprovalRequestStatus"
    `;
    if (claimed === 0) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'This request was already decided.' });
    }
    await this.writeDecisionAudit(admin, row, 'admin.approval.rejected', ctx, {});
    return this.get(admin, id);
  }

  /** The admin who asked withdraws a request that is still waiting. */
  async cancel(admin: AuthenticatedAdmin, id: string, ctx: AdminRequestContext = {}): Promise<ApprovalView> {
    const row = await this.load(id);
    if (row.requestedBy !== admin.adminId) {
      throw DomainException.of(FORBIDDEN, { details: { reason: 'NOT_THE_REQUESTER' } });
    }
    const claimed = await this.prisma.$executeRaw`
      UPDATE approval_requests SET status = 'CANCELLED'::"ApprovalRequestStatus", updated_at = clock_timestamp()
      WHERE id = ${id}::uuid AND status = 'PENDING'::"ApprovalRequestStatus"
    `;
    if (claimed === 0) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'This request is no longer waiting.' });
    }
    await this.writeDecisionAudit(admin, row, 'admin.approval.cancelled', ctx, {});
    return this.get(admin, id);
  }

  /** Mark requests nobody decided in time. Called on every list and approve; safe to run often. */
  async expireDue(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE approval_requests SET status = 'EXPIRED'::"ApprovalRequestStatus", updated_at = clock_timestamp()
      WHERE status = 'PENDING'::"ApprovalRequestStatus" AND expires_at <= clock_timestamp()
    `;
  }

  // ---- internals ----

  private async load(id: string): Promise<ApprovalRequest> {
    const row = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!row) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return row;
  }

  private requirePermission(admin: AuthenticatedAdmin, permission: AdminPermissionKey): void {
    if (!admin.permissions.includes(permission)) {
      throw DomainException.of(FORBIDDEN, { details: { requiredPermission: permission } });
    }
  }

  private assertCanDecide(admin: AuthenticatedAdmin, row: ApprovalRequest): void {
    this.requirePermission(admin, APPROVAL_PERMISSION[row.kind]);
    if (row.requestedBy === admin.adminId) {
      throw DomainException.of(FORBIDDEN, {
        message: 'A second admin must decide this request.',
        details: { reason: 'SAME_ADMIN' },
      });
    }
    if (row.status !== 'PENDING') {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'This request was already decided.', details: { status: row.status } });
    }
  }

  private async writeDecisionAudit(
    admin: AuthenticatedAdmin,
    row: ApprovalRequest,
    action: string,
    ctx: AdminRequestContext,
    extra: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audit.record({
        actorType: AuditActorType.ADMIN,
        actorId: admin.adminId,
        action,
        entityType: 'approval_request',
        entityId: row.id,
        reasonCode: row.reasonCode,
        requestId: ctx.requestId,
        ip: ctx.ip,
        metadata: { kind: row.kind, requestedBy: row.requestedBy, targetType: row.targetType, targetId: row.targetId, ...extra },
      });
    } catch (error) {
      this.logger.error(`Could not write the audit record for ${action}: ${String(error)}`);
    }
  }

  private view(row: ApprovalRequest, admin: AuthenticatedAdmin): ApprovalView {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      requestedBy: row.requestedBy,
      reasonCode: row.reasonCode,
      reasonText: row.reasonText,
      summary: row.summary,
      targetType: row.targetType,
      targetId: row.targetId,
      payload: row.payload as Record<string, unknown>,
      decidedBy: row.decidedBy,
      decisionNote: row.decisionNote,
      decidedAt: row.decidedAt,
      executedAt: row.executedAt,
      result: (row.result as Record<string, unknown> | null) ?? null,
      failureReason: row.failureReason,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      canDecide:
        row.status === 'PENDING' &&
        row.requestedBy !== admin.adminId &&
        admin.permissions.includes(APPROVAL_PERMISSION[row.kind]) &&
        row.expiresAt.getTime() > Date.now(),
    };
  }
}

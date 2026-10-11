import { Injectable } from '@nestjs/common';
import { AuditActorType, type EvidenceLink, type Prisma, type Report } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { ErrandStateService } from '../errands/errand-state.service.js';
import { ReliabilityService } from '../reliability/reliability.service.js';
import { EnforcementService } from '../enforcement/enforcement.service.js';
import { EvidenceService } from '../disputes/evidence.service.js';
import { toEvidenceDto } from '../disputes/dispute.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ERRAND_INVALID_STATE, RATE_LIMITED, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import type { CreateReportDto, ReportDto, ReportListQueryDto } from './report.dto.js';

const OPEN_STATUSES = ['OPEN', 'UNDER_REVIEW', 'ACTION_REQUIRED'] as const;
/** An upheld report of these types is a severe event: it skips the ladder and goes to an admin (Backend PRD 21.1). */
const SEVERE_REPORT_TYPES: readonly string[] = ['FRAUD', 'UNSAFE_BEHAVIOR', 'PROHIBITED_ITEM'];
/** An errand in one of these states can still be completed automatically one day. */
const LIVE_ERRAND_STATUSES = ['OPEN', 'RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED', 'DISPUTED'];

type ReportWithEvidence = Report & { evidence: EvidenceLink[] };

export function toReportDto(row: ReportWithEvidence, viewerId: string): ReportDto {
  return {
    id: row.id,
    targetType: row.targetType,
    type: row.type,
    status: row.status,
    description: row.description,
    errandId: row.errandId,
    outcome: row.outcome,
    resolvedAt: row.resolvedAt,
    firstResponseDueAt: row.slaDueAt,
    pausesAutoCompletion: row.pausesAutoCompletion && (OPEN_STATUSES as readonly string[]).includes(row.status),
    evidence: [...row.evidence].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((e) => toEvidenceDto(e, viewerId)),
    createdAt: row.createdAt,
  };
}

interface Resolved {
  targetUserId: string | null;
  errandId: string | null;
  assignmentId: string | null;
  messageId: string | null;
  ratingId: string | null;
  /** The reporter is a party of the errand, so an open report holds its auto-completion. */
  reporterIsParty: boolean;
}

/**
 * Reports (Backend PRD 21.2): a persistent complaint about a user, errand, message or rating.
 *
 * - A report never changes the errand status. One filed by a party of a live errand holds its
 *   auto-completion until the report is decided (Backend PRD 15.3); a report by a stranger does
 *   not, so it cannot be used to stall someone else's errand.
 * - `NON_PAYMENT` is a conduct complaint, not a payment case (Backend PRD 16.2). If an admin
 *   upholds any report about a user, a `VALID_REPORT_UPHELD` fact is recorded for them.
 * - Deciding a report that is not linked to a dispute restarts a fresh auto-completion window.
 */
@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: BusinessConfigService,
    private readonly cursors: CursorService,
    private readonly errandState: ErrandStateService,
    private readonly evidence: EvidenceService,
    private readonly reliability: ReliabilityService,
    private readonly enforcement: EnforcementService,
  ) {}

  // ---- Reporter ----

  async create(userId: string, input: CreateReportDto): Promise<ReportDto> {
    const [firstHours, maxOpen, maxEvidence] = await Promise.all([
      this.config.get('REPORT_FIRST_RESPONSE_HOURS'),
      this.config.get('REPORT_MAX_OPEN_PER_REPORTER'),
      this.config.get('REPORT_MAX_EVIDENCE_ITEMS'),
    ]);
    if ((input.evidence?.length ?? 0) > maxEvidence) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'Too many evidence items.', details: { field: 'evidence' } });
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const open = await tx.report.count({ where: { reporterId: userId, deletedAt: null, status: { in: [...OPEN_STATUSES] } } });
      if (open >= maxOpen) {
        throw DomainException.of(RATE_LIMITED, { message: 'You have too many open reports. Wait for some to be decided.' });
      }

      const target = await this.resolveTarget(tx, userId, input);
      const errand = target.errandId
        ? (await tx.errand.findFirst({ where: { id: target.errandId }, select: { status: true } })) ?? null
        : null;
      const pauses = target.reporterIsParty && errand !== null && LIVE_ERRAND_STATUSES.includes(errand.status);

      const dueRows = await tx.$queryRaw<Array<{ due: Date }>>`
        SELECT clock_timestamp() + make_interval(hours => ${firstHours}::int) AS due
      `;
      const created = await tx.report.create({
        data: {
          reporterId: userId,
          targetType: input.targetType,
          targetUserId: target.targetUserId,
          errandId: target.errandId,
          assignmentId: target.assignmentId,
          messageId: target.messageId,
          ratingId: target.ratingId,
          type: input.type,
          description: input.description.trim(),
          slaDueAt: dueRows[0].due,
          pausesAutoCompletion: pauses,
          retentionHold: true,
        },
      });
      for (const item of input.evidence ?? []) {
        await this.evidence.add(tx, { reportId: created.id }, userId, item, { errandId: target.errandId, assignmentId: target.assignmentId });
      }
      if (pauses && target.errandId) {
        await this.errandState.pauseAutoCompletion(tx, target.errandId);
      }

      await this.outbox.add(tx, {
        eventType: 'report.created',
        aggregateType: 'report',
        aggregateId: created.id,
        payload: {
          reportId: created.id,
          reporterId: userId,
          targetType: input.targetType,
          targetUserId: target.targetUserId,
          errandId: target.errandId,
          assignmentId: target.assignmentId,
          type: input.type,
          pausesAutoCompletion: pauses,
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'report.created',
        entityType: 'report',
        entityId: created.id,
        metadata: { targetType: input.targetType, type: input.type, errandId: target.errandId, pausesAutoCompletion: pauses },
      });
      return tx.report.findUniqueOrThrow({ where: { id: created.id }, include: { evidence: true } });
    });
    return toReportDto(row, userId);
  }

  async get(userId: string, reportId: string): Promise<ReportDto> {
    const row = await this.prisma.report.findFirst({
      where: { id: reportId, reporterId: userId, deletedAt: null },
      include: { evidence: true },
    });
    if (!row) throw DomainException.of(RESOURCE_NOT_FOUND);
    return toReportDto(row, userId);
  }

  /** The reports the user filed, newest first. */
  async listMine(userId: string, query: ReportListQueryDto): Promise<Paginated<ReportDto>> {
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await this.prisma.report.findMany({
      where: {
        reporterId: userId,
        deletedAt: null,
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt as Date } }, { createdAt: cursor.createdAt as Date, id: { lt: cursor.id } }] }
          : {}),
      },
      include: { evidence: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return new Paginated(
      page.map((row) => toReportDto(row, userId)),
      {
        hasNextPage,
        ...(hasNextPage && last
          ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) }
          : {}),
      },
    );
  }

  // ---- Admin (controllers arrive with P11) ----

  /** The first admin response, or a move between review states. Sets the SLA marker once. */
  async adminSetStatus(reportId: string, status: 'UNDER_REVIEW' | 'ACTION_REQUIRED', actor: { adminId: string }): Promise<Report> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lockOpen(tx, reportId);
      const updated = await tx.report.update({
        where: { id: row.id },
        data: { status, firstResponseAt: row.firstResponseAt ?? new Date() },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: actor.adminId,
        action: 'report.status_changed',
        entityType: 'report',
        entityId: reportId,
        metadata: { from: row.status, to: status },
      });
      return updated;
    });
  }

  /** An admin links a report to a dispute (Backend PRD 21.3). A linked report no longer restarts completion. */
  async adminLinkToDispute(reportId: string, disputeId: string, actor: { adminId: string }): Promise<Report> {
    return this.prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findFirst({ where: { id: disputeId, deletedAt: null }, select: { id: true } });
      if (!dispute) throw DomainException.of(RESOURCE_NOT_FOUND);
      const row = await this.lockOpen(tx, reportId);
      const updated = await tx.report.update({ where: { id: row.id }, data: { disputeId } });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: actor.adminId,
        action: 'report.linked_to_dispute',
        entityType: 'report',
        entityId: reportId,
        metadata: { disputeId },
      });
      return updated;
    });
  }

  /** Decide a report. UPHELD records a VALID_REPORT_UPHELD fact for the person reported. */
  async adminResolve(
    reportId: string,
    input: { outcome: 'UPHELD' | 'DISMISSED'; resolution: string },
    actor: { adminId: string },
  ): Promise<Report> {
    const table = await this.reliability.pointsTable();
    const resolution = input.resolution.trim();
    if (!resolution) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'A decision needs a note.', details: { field: 'resolution' } });
    }
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lockOpen(tx, reportId);
      const now = new Date();
      const updated = await tx.report.update({
        where: { id: row.id },
        data: {
          status: input.outcome === 'UPHELD' ? 'RESOLVED' : 'DISMISSED',
          outcome: input.outcome,
          resolution,
          resolvedBy: actor.adminId,
          resolvedAt: now,
          firstResponseAt: row.firstResponseAt ?? now,
          retentionHold: false,
        },
      });

      if (input.outcome === 'UPHELD' && row.targetUserId) {
        await this.reliability.record(tx, {
          userId: row.targetUserId,
          type: 'VALID_REPORT_UPHELD',
          points: this.reliability.pointsFor(table, 'VALID_REPORT_UPHELD'),
          errandId: row.errandId,
          assignmentId: row.assignmentId,
          occurredAt: now,
          source: AuditActorType.ADMIN,
          actorId: actor.adminId,
          metadata: { reportId, reportType: row.type },
          dedupeKey: `report:${reportId}:upheld`,
        });
      }

      if (input.outcome === 'UPHELD' && row.targetUserId && SEVERE_REPORT_TYPES.includes(row.type)) {
        await this.enforcement.flagSevere(tx, row.targetUserId, {
          reason: `A ${row.type.toLowerCase().replace(/_/g, ' ')} report was upheld.`,
          caseRef: `report:${reportId}`,
        });
      }

      // A report decided without a dispute restarts a fresh window (Backend PRD 15.3).
      let resumed = false;
      if (row.pausesAutoCompletion && row.errandId && !row.disputeId) {
        resumed = await this.errandState.resumeAutoCompletion(tx, row.errandId);
      }

      await this.outbox.add(tx, {
        eventType: 'report.resolved',
        aggregateType: 'report',
        aggregateId: reportId,
        payload: {
          reportId,
          reporterId: row.reporterId,
          targetUserId: row.targetUserId,
          errandId: row.errandId,
          outcome: input.outcome,
          autoCompletionRestarted: resumed,
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: actor.adminId,
        action: 'report.resolved',
        entityType: 'report',
        entityId: reportId,
        reasonCode: input.outcome,
        metadata: { reportType: row.type, targetUserId: row.targetUserId, autoCompletionRestarted: resumed },
      });
      return updated;
    });
  }

  // ---- Internals ----

  private async lockOpen(tx: Prisma.TransactionClient, reportId: string): Promise<Report> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM reports
      WHERE id = ${reportId}::uuid AND deleted_at IS NULL
        AND status IN ('OPEN'::"ReportStatus", 'UNDER_REVIEW'::"ReportStatus", 'ACTION_REQUIRED'::"ReportStatus")
      FOR UPDATE
    `;
    if (!locked[0]) {
      const exists = await tx.report.findFirst({ where: { id: reportId, deletedAt: null }, select: { id: true } });
      throw exists
        ? DomainException.of(ERRAND_INVALID_STATE, { message: 'This report was already decided.', details: { reason: 'REPORT_CLOSED' } })
        : DomainException.of(RESOURCE_NOT_FOUND);
    }
    return tx.report.findUniqueOrThrow({ where: { id: reportId } });
  }

  /** Work out who and what the report is about, and check the reporter may report it. */
  private async resolveTarget(tx: Prisma.TransactionClient, userId: string, input: CreateReportDto): Promise<Resolved> {
    const notFound = () => DomainException.of(RESOURCE_NOT_FOUND);
    const selfReport = () => DomainException.of(VALIDATION_ERROR, { message: 'You cannot report yourself.', details: { field: 'targetId' } });
    const base: Resolved = { targetUserId: null, errandId: null, assignmentId: null, messageId: null, ratingId: null, reporterIsParty: false };

    // The assignment between the reporter and a user, optionally for one errand (latest first).
    const assignmentBetween = async (otherId: string, errandId?: string) =>
      tx.assignment.findFirst({
        where: {
          deletedAt: null,
          ...(errandId ? { errandId } : {}),
          OR: [
            { requesterId: userId, runnerId: otherId },
            { requesterId: otherId, runnerId: userId },
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, errandId: true },
      });

    switch (input.targetType) {
      case 'USER': {
        if (input.targetId === userId) throw selfReport();
        const user = await tx.user.findFirst({ where: { id: input.targetId, deletedAt: null }, select: { id: true } });
        if (!user) throw notFound();
        let assignment: { id: string; errandId: string } | null = null;
        if (input.assignmentId) {
          assignment = await tx.assignment.findFirst({
            where: {
              id: input.assignmentId,
              deletedAt: null,
              OR: [
                { requesterId: userId, runnerId: input.targetId },
                { requesterId: input.targetId, runnerId: userId },
              ],
            },
            select: { id: true, errandId: true },
          });
          if (!assignment) throw notFound();
        }
        return {
          ...base,
          targetUserId: input.targetId,
          assignmentId: assignment?.id ?? null,
          errandId: assignment?.errandId ?? null,
          reporterIsParty: assignment !== null,
        };
      }
      case 'ERRAND': {
        const errand = await tx.errand.findFirst({
          where: { id: input.targetId, deletedAt: null, status: { not: 'DRAFT' } },
          select: { id: true, requesterId: true },
        });
        if (!errand) throw notFound();
        if (errand.requesterId === userId) throw selfReport();
        const assignment = await tx.assignment.findFirst({
          where: { errandId: errand.id, runnerId: userId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        return {
          ...base,
          targetUserId: errand.requesterId,
          errandId: errand.id,
          assignmentId: assignment?.id ?? null,
          reporterIsParty: assignment !== null,
        };
      }
      case 'MESSAGE': {
        const message = await tx.message.findFirst({
          where: {
            id: input.targetId,
            deletedAt: null,
            conversation: { deletedAt: null, OR: [{ requesterId: userId }, { runnerId: userId }] },
          },
          select: { id: true, senderId: true, conversation: { select: { errandId: true } } },
        });
        if (!message) throw notFound();
        if (message.senderId === userId) throw selfReport();
        const assignment = await assignmentBetween(message.senderId, message.conversation.errandId);
        return {
          ...base,
          targetUserId: message.senderId,
          errandId: message.conversation.errandId,
          assignmentId: assignment?.id ?? null,
          messageId: message.id,
          reporterIsParty: assignment !== null,
        };
      }
      case 'RATING': {
        // Only the person rated, and only once the rating is visible to them.
        const rating = await tx.rating.findFirst({
          where: { id: input.targetId, rateeId: userId, deletedAt: null, revealedAt: { not: null } },
          select: { id: true, raterId: true, assignmentId: true, assignment: { select: { errandId: true } } },
        });
        if (!rating) throw notFound();
        return {
          ...base,
          targetUserId: rating.raterId,
          errandId: rating.assignment.errandId,
          assignmentId: rating.assignmentId,
          ratingId: rating.id,
          reporterIsParty: true,
        };
      }
    }
  }
}

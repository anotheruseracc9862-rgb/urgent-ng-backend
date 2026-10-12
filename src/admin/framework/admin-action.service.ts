import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { VALIDATION_ERROR } from '../../common/constants/error-codes.js';
import type { AuthenticatedAdmin } from '../decorators/admin-auth.decorator.js';
import { REASON_TEXT_REQUIRED, type AdminReason } from './admin-reasons.js';

export interface AdminRequestContext {
  requestId?: string;
  ip?: string;
}

export interface AdminActionInput<T> {
  admin: AuthenticatedAdmin;
  /** Dotted action name, for example `user.suspend`. Failures are recorded as `<action>.failed`. */
  action: string;
  entityType: string;
  entityId?: string;
  reason: AdminReason;
  ctx?: AdminRequestContext;
  /** Read the state before the change. Only a keyed hash is stored, so it may hold sensitive values. */
  before?: () => Promise<Record<string, unknown>>;
  /** Read the state after the change (same rules). */
  after?: () => Promise<Record<string, unknown>>;
  /** Plain facts for the record: ids, counts, names of fields. Never personal data. */
  metadata?: Record<string, unknown>;
  /** The change itself: call the domain service (it owns the transaction, state machine and events). */
  execute: () => Promise<T>;
}

/**
 * Runs an admin write the way Backend PRD 24.5 asks: a reason is required, the change goes through
 * the same domain service a user action would, and one audit record is written with the admin, the
 * reason, a hash of the state before and after, and the request id. A failed attempt is audited too
 * (`<action>.failed`), then the error continues to the caller unchanged.
 *
 * The wrapper never writes a business table itself: `execute` is always a domain-service call.
 */
@Injectable()
export class AdminActionService {
  private readonly logger = new Logger(AdminActionService.name);

  constructor(private readonly audit: AuditService) {}

  async run<T>(input: AdminActionInput<T>): Promise<T> {
    this.assertReason(input.reason);
    const before = input.before ? await input.before() : undefined;

    let result: T;
    try {
      result = await input.execute();
    } catch (error) {
      await this.write(input, `${input.action}.failed`, before, undefined, {
        error: error instanceof DomainException ? error.code : 'UNEXPECTED',
      });
      throw error;
    }

    const after = input.after ? await input.after() : undefined;
    await this.write(input, input.action, before, after, {});
    return result;
  }

  /** The reason is required on every admin write; free text is required for OTHER. */
  assertReason(reason: AdminReason): void {
    if (REASON_TEXT_REQUIRED.includes(reason.code) && !reason.text?.trim()) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Explain the reason: free text is required when the reason code is OTHER.',
        details: { field: 'reasonText' },
      });
    }
  }

  private async write(
    input: AdminActionInput<unknown>,
    action: string,
    before: Record<string, unknown> | undefined,
    after: Record<string, unknown> | undefined,
    extra: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audit.record({
        actorType: AuditActorType.ADMIN,
        actorId: input.admin.adminId,
        action: `admin.${action}`,
        entityType: input.entityType,
        entityId: input.entityId,
        reasonCode: input.reason.code,
        requestId: input.ctx?.requestId,
        ip: input.ctx?.ip,
        before,
        after,
        metadata: {
          ...input.metadata,
          ...extra,
          ...(input.reason.text ? { reasonText: input.reason.text } : {}),
          changed: before && after ? changedKeys(before, after) : undefined,
        },
      });
    } catch (error) {
      // The change already happened: do not turn a logging fault into a failed request.
      this.logger.error(`Could not write the audit record for ${action}: ${String(error)}`);
    }
  }
}

/** The names of the fields that differ, so the record says what changed without storing values. */
export function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();
}

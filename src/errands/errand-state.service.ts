import { Injectable } from '@nestjs/common';
import { AuditActorType, type ErrandCancellationReason, type ErrandStatus, type Prisma } from '@prisma/client';
import { BusinessConfigService } from '../config/business-config.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { lockRow } from '../database/lock-row.helper.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ERRAND_INVALID_STATE, FORBIDDEN, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { OfferService } from '../offers/offer.service.js';
import { AssignmentTransitionRegistry } from './assignment-transition.registry.js';
import { computeExpiresAt } from './errand-expiry.js';
import { eventFor, findTransition, type ErrandActor } from './errand.state.js';

/** The row as read under `FOR UPDATE`. Only the columns the state machine needs. */
export interface LockedErrand {
  id: string;
  requester_id: string;
  status: ErrandStatus;
  status_before_dispute: ErrandStatus | null;
  version: number;
  time_mode: 'ASAP' | 'SCHEDULED' | null;
  scheduled_at: Date | null;
  expires_at: Date | null;
  auto_complete_at: Date | null;
  past_expiry: boolean;
  db_now: Date;
}

export interface TransitionInput {
  errandId: string;
  to: ErrandStatus;
  actor: { type: ErrandActor; id?: string };
  /** The requester's id. When given, any other owner is answered as "not found". */
  ownerId?: string;
  /** Reject the call unless the errand has this version (optimistic locking). */
  expectedVersion?: number;
  /** Reject the call unless the errand is in one of these statuses (the action's precondition). */
  expectedFrom?: ErrandStatus | readonly ErrandStatus[];
  /** Required when `to` is CANCELLED. */
  cancellation?: { reason: ErrandCancellationReason; note?: string };
  /** Free text for the history row. */
  reason?: string;
  /** Extra outbox payload. */
  eventPayload?: Record<string, unknown>;
  /**
   * Set by the assignment module for the transitions it performs itself (accept, decline,
   * timeout): it has already updated the assignment, so the sync hook is skipped.
   */
  assignmentHandled?: true;
  /**
   * Runs inside the lock, after every check and before the status changes. Use it to write the
   * fields that belong to the action (publishing writes its timing here).
   */
  apply?: (tx: Prisma.TransactionClient, errand: LockedErrand) => Promise<void>;
}

export interface TransitionResult {
  errandId: string;
  from: ErrandStatus;
  /** Can differ from `to` when a reopening finds the deadline already passed (it ends as EXPIRED). */
  to: ErrandStatus;
  version: number;
}

const LOCK_COLUMNS = `id, requester_id, status::text AS status, status_before_dispute::text AS status_before_dispute,
  version, time_mode::text AS time_mode, scheduled_at, expires_at, auto_complete_at,
  (expires_at IS NOT NULL AND expires_at <= clock_timestamp()) AS past_expiry,
  clock_timestamp() AS db_now`;

const auditActor = (type: ErrandActor): AuditActorType =>
  type === 'ADMIN' ? AuditActorType.ADMIN : type === 'SYSTEM' ? AuditActorType.SYSTEM : AuditActorType.USER;

/**
 * The only code that changes `errands.status` (Backend PRD 11.6). One call is one transition,
 * inside the caller's transaction: lock the row, check who and from where, change the status,
 * and write the history, audit and outbox rows with it. The caller commits.
 */
@Injectable()
export class ErrandStateService {
  constructor(
    private readonly config: BusinessConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly offerService: OfferService,
    private readonly assignmentTransitions: AssignmentTransitionRegistry,
  ) {}

  async transition(tx: Prisma.TransactionClient, input: TransitionInput): Promise<TransitionResult> {
    const errand = await lockRow<LockedErrand>(tx, 'errands', input.errandId, LOCK_COLUMNS);
    if (!errand || (input.ownerId && errand.requester_id !== input.ownerId)) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    const from = errand.status;

    const allowedFrom = input.expectedFrom === undefined ? undefined : ([] as ErrandStatus[]).concat(input.expectedFrom);
    if (allowedFrom && !allowedFrom.includes(from)) {
      throw this.invalid(from, input.to, 'This errand is not in a state that allows this action.');
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== errand.version) {
      throw this.invalid(from, input.to, 'The errand changed. Reload it and try again.', 'VERSION_MISMATCH');
    }

    const requested = findTransition(from, input.to);
    if (!requested) {
      throw this.invalid(from, input.to, `An errand that is ${from} cannot become ${input.to}.`);
    }
    if (!requested.actors.includes(input.actor.type)) {
      throw DomainException.of(FORBIDDEN, { details: { from, to: input.to, actor: input.actor.type } });
    }
    // A dismissed dispute returns to the status it came from, and to no other.
    if (from === 'DISPUTED' && ['ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED'].includes(input.to)) {
      if (errand.status_before_dispute !== input.to) {
        throw this.invalid(from, input.to, 'A dismissed dispute returns the errand to the status it had before.');
      }
    }
    if (requested.needsCancellation && !input.cancellation) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'A cancellation reason is required.' });
    }

    let to = input.to;
    let newExpiry: Date | null = null;
    if (to === 'OPEN' && requested.expiry) {
      if (requested.expiry === 'RECOMPUTE') {
        newExpiry = await this.recomputeExpiry(errand);
      }
      const ended = requested.expiry === 'KEEP' ? errand.past_expiry : newExpiry !== null && newExpiry <= errand.db_now;
      if (ended) {
        to = 'EXPIRED';
        newExpiry = null;
      }
    }

    if (input.apply) {
      await input.apply(tx, errand);
    }
    const version = errand.version + 1;
    await this.write(tx, errand, to, input, newExpiry, version);

    await tx.$executeRaw`
      INSERT INTO errand_status_history (errand_id, from_status, to_status, actor_type, actor_id, reason, version)
      VALUES (${errand.id}::uuid, ${from}::"ErrandStatus", ${to}::"ErrandStatus", ${auditActor(input.actor.type)}::"AuditActorType",
              ${input.actor.id ?? null}::uuid, ${input.reason ?? input.cancellation?.note ?? null}, ${version})
    `;
    await this.audit.recordInTransaction(tx, {
      actorType: auditActor(input.actor.type),
      actorId: input.actor.id,
      action: 'errand.status_changed',
      entityType: 'errand',
      entityId: errand.id,
      before: { status: from },
      after: { status: to },
      reasonCode: input.cancellation?.reason,
      metadata: { from, to, version },
    });
    await this.outbox.add(tx, {
      eventType: eventFor(from, to),
      aggregateType: 'errand',
      aggregateId: errand.id,
      payload: {
        errandId: errand.id,
        requesterId: errand.requester_id,
        from,
        to,
        version,
        actorType: input.actor.type,
        actorId: input.actor.id ?? null,
        ...input.eventPayload,
      },
    });

    if (to === 'CANCELLED' || to === 'EXPIRED') {
      await this.offerService.closeForErrand(tx, errand.id, to === 'EXPIRED' ? 'ERRAND_EXPIRED' : 'ERRAND_CANCELLED');
    }

    if (!input.assignmentHandled) {
      await this.assignmentTransitions.run(tx, {
        errandId: errand.id,
        from,
        to,
        actor: input.actor,
        cancellation: input.cancellation,
        reason: input.reason,
      });
    }

    return { errandId: errand.id, from, to, version };
  }

  /** A new deadline counted from the moment the errand reopens (Backend PRD 11.4). */
  private async recomputeExpiry(errand: LockedErrand): Promise<Date> {
    const [expiryHours, scheduledBufferMinutes, scheduledMaxOpenDays] = await Promise.all([
      this.config.get('ERRAND_EXPIRY_HOURS'),
      this.config.get('SCHEDULED_EXPIRY_BUFFER_MINUTES'),
      this.config.get('SCHEDULED_ERRAND_MAX_OPEN_DAYS'),
    ]);
    return computeExpiresAt(errand.time_mode ?? 'ASAP', errand.scheduled_at, errand.db_now, {
      expiryHours,
      scheduledBufferMinutes,
      scheduledMaxOpenDays,
    });
  }

  private async write(
    tx: Prisma.TransactionClient,
    errand: LockedErrand,
    to: ErrandStatus,
    input: TransitionInput,
    newExpiry: Date | null,
    version: number,
  ): Promise<void> {
    const from = errand.status;
    const now = errand.db_now;
    const autoCompleteHours = await this.config.get('DELIVERY_AUTO_COMPLETION_HOURS');

    // The deadline for auto-completion starts when the errand is delivered (again, after a dismissed dispute).
    const autoCompleteAt =
      to === 'DELIVERED' ? new Date(now.getTime() + autoCompleteHours * 3_600_000) : ['COMPLETED', 'CANCELLED', 'DISPUTED', 'EXPIRED'].includes(to) ? null : errand.auto_complete_at;
    const statusBeforeDispute = to === 'DISPUTED' ? from : from === 'DISPUTED' ? null : errand.status_before_dispute;
    const cancelling = to === 'CANCELLED' ? input.cancellation : undefined;

    await tx.$executeRaw`
      UPDATE errands SET
        status = ${to}::"ErrandStatus",
        status_before_dispute = ${statusBeforeDispute}::"ErrandStatus",
        version = ${version},
        expires_at = COALESCE(${newExpiry}::timestamptz, expires_at),
        auto_complete_at = ${autoCompleteAt}::timestamptz,
        delivered_at = CASE WHEN ${to === 'DELIVERED'}::boolean THEN ${now}::timestamptz ELSE delivered_at END,
        completed_at = CASE WHEN ${to === 'COMPLETED'}::boolean THEN ${now}::timestamptz ELSE completed_at END,
        cancelled_at = CASE WHEN ${cancelling !== undefined}::boolean THEN ${now}::timestamptz ELSE cancelled_at END,
        cancellation_reason = COALESCE(${cancelling?.reason ?? null}::"ErrandCancellationReason", cancellation_reason),
        cancellation_note = COALESCE(${cancelling?.note ?? null}, cancellation_note),
        cancelled_by = COALESCE(${cancelling ? (input.actor.id ?? null) : null}::uuid, cancelled_by),
        cancelled_by_type = COALESCE(${cancelling ? auditActor(input.actor.type) : null}::"AuditActorType", cancelled_by_type),
        updated_at = ${now}::timestamptz
      WHERE id = ${errand.id}::uuid
    `;
  }

  private invalid(from: ErrandStatus, to: ErrandStatus, message: string, reason?: string): DomainException {
    return DomainException.of(ERRAND_INVALID_STATE, { message, details: { from, to, ...(reason ? { reason } : {}) } });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType, type Assignment, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  ASSIGNMENT_ACCEPTANCE_EXPIRED,
  ASSIGNMENT_CONFLICT,
  ASSIGNMENT_INVALID_STATE,
  ERRAND_EXPIRED,
  ERRAND_INVALID_STATE,
  OFFER_NOT_ELIGIBLE,
  RESOURCE_NOT_FOUND,
  VALIDATION_ERROR,
} from '../common/constants/error-codes.js';
import { ErrandStateService } from '../errands/errand-state.service.js';
import { OfferService } from '../offers/offer.service.js';
import { RunnerEligibilityService } from '../runner/runner-eligibility.service.js';
import { ErrandViewService } from '../errands/errand-view.service.js';
import { ErrandLifecycleService } from '../errands/errand-lifecycle.service.js';
import type { AssignedErrandDto, AssignmentDetailDto, AssignmentDto, CancelAssignmentDto, SelectRunnerDto } from './assignment.dto.js';

/** Reasons a runner may give when cancelling an accepted assignment. */
const RUNNER_REASONS = ['RUNNER_CANCELLED', 'SAFETY_CONCERN', 'OTHER'] as const;

/** Errand statuses that mean "someone already selected a runner" (the loser of a select race). */
const ALREADY_SELECTED: readonly string[] = ['RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED', 'DISPUTED', 'COMPLETED'];

/**
 * A select that lost the race answers ASSIGNMENT_CONFLICT (a refetch fixes it); every other wrong
 * state keeps ERRAND_INVALID_STATE. Exported for tests.
 */
export function mapSelectionError(error: unknown): unknown {
  if (error instanceof DomainException && error.getCode() === ERRAND_INVALID_STATE) {
    const from = (error.getDetails() as { from?: string } | undefined)?.from;
    if (from && ALREADY_SELECTED.includes(from)) {
      return DomainException.of(ASSIGNMENT_CONFLICT, { details: { errandStatus: from } });
    }
  }
  return error;
}

export function toAssignmentDto(row: Assignment): AssignmentDto {
  return {
    id: row.id,
    errandId: row.errandId,
    offerId: row.selectedOfferId,
    requesterId: row.requesterId,
    runnerId: row.runnerId,
    status: row.status,
    agreedAmountMinor: Number(row.agreedAmountMinor),
    currency: row.currency,
    selectedAt: row.selectedAt,
    acceptanceDeadline: row.acceptanceDeadline,
    acceptedAt: row.acceptedAt,
    declinedAt: row.declinedAt,
    timedOutAt: row.timedOutAt,
    cancelledAt: row.cancelledAt,
    completedAt: row.completedAt,
    version: row.version,
  };
}

/**
 * Selecting a runner and the assignment's life until acceptance (Backend PRD 14). Everything is
 * one transaction per action. Lock order: errand row, runner advisory lock, offer rows.
 */
/** Raised inside a timeout transaction that finds the deadline not reached: roll back, change nothing. */
class NotDue extends Error {}

@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly errandState: ErrandStateService,
    private readonly offers: OfferService,
    private readonly eligibility: RunnerEligibilityService,
    private readonly errandViews: ErrandViewService,
    private readonly lifecycle: ErrandLifecycleService,
  ) {}

  /** Backend PRD 14.2 and 26.4. */
  async selectRunner(requesterId: string, errandId: string, input: SelectRunnerDto): Promise<AssignmentDto> {
    // Anything that needs a pool connection is read before the transaction.
    const [acceptanceMinutes, maxConcurrent] = await Promise.all([
      this.config.get('ASSIGNMENT_ACCEPTANCE_MINUTES'),
      this.config.get('MAX_CONCURRENT_ASSIGNMENTS_PER_RUNNER'),
    ]);
    const candidate = await this.prisma.offer.findFirst({
      where: { id: input.offerId, errandId, requesterId },
      select: { runnerId: true },
    });
    if (!candidate) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    const eligibility = await this.eligibility.canOffer(candidate.runnerId);
    if (!eligibility.allowed) {
      throw DomainException.of(OFFER_NOT_ELIGIBLE, {
        message: 'This runner can no longer take errands.',
        details: { reasons: eligibility.reasons },
      });
    }

    let created: Assignment | undefined;
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.errandState.transition(tx, {
          errandId,
          to: 'RUNNER_SELECTED',
          ownerId: requesterId,
          expectedFrom: 'OPEN',
          actor: { type: 'REQUESTER', id: requesterId },
          reason: 'Requester selected a runner.',
          // Runs under the errand lock, before the status changes.
          apply: async (inner, errand) => {
            if (errand.past_expiry) {
              throw DomainException.of(ERRAND_EXPIRED);
            }
            // One serialisation point per runner, so the cap holds across different errands.
            await inner.$executeRaw`
              SELECT pg_advisory_xact_lock(hashtextextended(${`runner-assign:${candidate.runnerId}`}, 0))
            `;
            const offer = await this.offers.lockForSelection(inner, input.offerId, errandId, input.expectedOfferVersion);
            if (offer.runnerId !== candidate.runnerId || offer.requesterId !== requesterId) {
              throw DomainException.of(RESOURCE_NOT_FOUND);
            }
            const live = await inner.assignment.count({
              where: { runnerId: offer.runnerId, status: { in: ['PENDING_ACCEPTANCE', 'ACCEPTED'] } },
            });
            if (live >= maxConcurrent) {
              throw DomainException.of(OFFER_NOT_ELIGIBLE, {
                message: 'This runner already has the maximum number of active errands.',
                details: { reasons: ['RUNNER_AT_CAPACITY'], maxConcurrent },
              });
            }

            created = await inner.assignment.create({
              data: {
                errandId,
                requesterId,
                runnerId: offer.runnerId,
                selectedOfferId: offer.id,
                status: 'PENDING_ACCEPTANCE',
                // The amount is copied now; later offer changes never move it (PRD 14.2 step 5).
                agreedAmountMinor: offer.amountMinor,
                selectedAt: errand.db_now,
                acceptanceDeadline: new Date(errand.db_now.getTime() + acceptanceMinutes * 60_000),
              },
            });
            await this.offers.markSelected(inner, offer, requesterId);
            await this.offers.closeOthersOnSelection(inner, errandId, offer.id);

            await this.outbox.add(inner, {
              eventType: 'assignment.selected',
              aggregateType: 'assignment',
              aggregateId: created.id,
              payload: {
                assignmentId: created.id,
                errandId,
                requesterId,
                runnerId: offer.runnerId,
                offerId: offer.id,
                agreedAmountMinor: Number(offer.amountMinor),
                acceptanceDeadline: created.acceptanceDeadline,
              },
            });
            await this.audit.recordInTransaction(inner, {
              actorType: AuditActorType.USER,
              actorId: requesterId,
              action: 'assignment.selected',
              entityType: 'assignment',
              entityId: created.id,
              after: { status: 'PENDING_ACCEPTANCE', agreedAmountMinor: Number(offer.amountMinor) },
              metadata: { errandId, offerId: offer.id, runnerId: offer.runnerId },
            });
          },
        });
      });
    } catch (error) {
      throw mapSelectionError(error);
    }
    if (!created) {
      throw DomainException.of(ASSIGNMENT_CONFLICT);
    }
    return toAssignmentDto(created);
  }

  // ---- Cancellation by stage (Backend PRD 11.7) ----

  /**
   * Either party cancels a live assignment. The requester's cancel is the errand cancel (one rule
   * table, one code path); the runner's depends on the stage:
   *
   *   RUNNER_SELECTED  not a cancel: the runner declines
   *   ACCEPTED         the errand returns to OPEN with a new deadline; the assignment is cancelled
   *   IN_PROGRESS      the errand is cancelled; high severity for reliability (Phase 9)
   *   PICKED_UP        no plain cancel: a dispute or safety workflow
   *
   * The assignment itself is updated by the transition hook, so every path agrees.
   */
  async cancel(userId: string, assignmentId: string, input: CancelAssignmentDto): Promise<AssignmentDto> {
    const row = await this.prisma.assignment.findFirst({
      where: { id: assignmentId, OR: [{ requesterId: userId }, { runnerId: userId }] },
    });
    if (!row) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (row.status !== 'PENDING_ACCEPTANCE' && row.status !== 'ACCEPTED') {
      throw DomainException.of(ASSIGNMENT_INVALID_STATE, { details: { status: row.status } });
    }

    if (row.requesterId === userId) {
      // Only the stage the requester saw: if the runner cancelled in the meantime (the errand is OPEN
      // again), this is not the cancel the requester asked for, and the errand must stay.
      const seen = row.status === 'PENDING_ACCEPTANCE' ? (['RUNNER_SELECTED'] as const) : (['ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED'] as const);
      await this.lifecycle.cancel(userId, row.errandId, { reason: input.reason, note: input.note }, seen);
    } else {
      await this.runnerCancel(userId, row, input);
    }
    return toAssignmentDto(await this.prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } }));
  }

  private async runnerCancel(runnerId: string, row: Assignment, input: CancelAssignmentDto): Promise<void> {
    if (!(RUNNER_REASONS as readonly string[]).includes(input.reason)) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'Choose one of the cancellation reasons offered.', details: { field: 'reason' } });
    }
    if (row.status === 'PENDING_ACCEPTANCE') {
      throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
        message: 'You have not accepted yet. Decline the assignment instead.',
        details: { status: row.status, suggestedAction: 'DECLINE' },
      });
    }
    const errand = await this.prisma.errand.findFirst({ where: { id: row.errandId }, select: { status: true } });
    const stage = errand?.status;
    if (stage !== 'ACCEPTED' && stage !== 'IN_PROGRESS') {
      throw DomainException.of(ERRAND_INVALID_STATE, {
        message:
          stage === 'PICKED_UP' || stage === 'DELIVERED'
            ? 'The item was already picked up. Open a dispute if there is a problem.'
            : 'This errand cannot be cancelled in its current state.',
        details: {
          from: stage,
          to: 'CANCELLED',
          ...(stage === 'PICKED_UP' || stage === 'DELIVERED' ? { suggestedAction: 'OPEN_DISPUTE' } : {}),
        },
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await this.errandState.transition(tx, {
        errandId: row.errandId,
        // Before work started the errand goes back to the marketplace; after, it ends.
        to: stage === 'ACCEPTED' ? 'OPEN' : 'CANCELLED',
        expectedFrom: stage,
        actor: { type: 'RUNNER', id: runnerId },
        cancellation: { reason: input.reason, note: input.note },
        reason: input.note ?? 'Runner cancelled.',
        eventPayload: { stage, assignmentId: row.id, runnerId, severity: stage === 'IN_PROGRESS' ? 'HIGH' : 'LOW' },
        apply: async (inner) => {
          const locked = await inner.$queryRaw<Array<{ runner_id: string; status: string }>>`
            SELECT runner_id::text, status::text AS status FROM assignments
            WHERE id = ${row.id}::uuid AND deleted_at IS NULL FOR UPDATE
          `;
          if (!locked[0] || locked[0].runner_id !== runnerId) {
            throw DomainException.of(RESOURCE_NOT_FOUND);
          }
          if (locked[0].status !== 'ACCEPTED') {
            throw DomainException.of(ASSIGNMENT_INVALID_STATE, { details: { status: locked[0].status } });
          }
        },
      });
    });
  }

  // ---- Accept, decline, timeout (Backend PRD 14.3, 14.4) ----

  /**
   * The selected runner accepts. Server time is authoritative: success needs the transaction to
   * see the deadline still ahead (`now < deadline`, the mirror of the sweeper's `deadline <= now`).
   */
  async accept(runnerId: string, assignmentId: string): Promise<AssignmentDto> {
    const errandId = await this.errandIdOf(assignmentId, runnerId);
    let result: Assignment | undefined;
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.errandState.transition(tx, {
          errandId,
          to: 'ACCEPTED',
          expectedFrom: 'RUNNER_SELECTED',
          actor: { type: 'RUNNER', id: runnerId },
          reason: 'Runner accepted the assignment.',
          assignmentHandled: true,
          apply: async (inner, errand) => {
            const row = await this.lockPending(inner, assignmentId, runnerId);
            if (!row.within_deadline) {
              throw DomainException.of(ASSIGNMENT_ACCEPTANCE_EXPIRED);
            }
            result = await inner.assignment.update({
              where: { id: assignmentId },
              data: { status: 'ACCEPTED', acceptedAt: errand.db_now, version: { increment: 1 } },
            });
            // The agreement starts from the amount fixed at selection (PRD 16.1).
            await inner.paymentAgreement.create({
              data: { assignmentId, agreedAmountMinor: result.agreedAmountMinor, currency: result.currency },
            });
            await this.publish(inner, 'assignment.accepted', result, { type: 'USER', id: runnerId }, {});
          },
        });
      });
    } catch (error) {
      if (error instanceof DomainException && error.getCode() === ASSIGNMENT_ACCEPTANCE_EXPIRED) {
        // A late accept also settles the timer now instead of waiting for the sweeper.
        await this.expireIfDue(assignmentId).catch(() => undefined);
      }
      throw error;
    }
    if (!result) throw DomainException.of(ASSIGNMENT_CONFLICT);
    return toAssignmentDto(result);
  }

  /** The selected runner declines. The errand reopens (or ends as EXPIRED if its deadline passed). */
  async decline(runnerId: string, assignmentId: string): Promise<AssignmentDto> {
    const errandId = await this.errandIdOf(assignmentId, runnerId);
    const result = await this.reopen(errandId, assignmentId, { runnerId, outcome: 'DECLINED' });
    if (!result) throw DomainException.of(ASSIGNMENT_CONFLICT);
    return toAssignmentDto(result);
  }

  /** Time out one assignment if its deadline has passed. Returns true when it was timed out. */
  async expireIfDue(assignmentId: string): Promise<boolean> {
    const found = await this.prisma.assignment.findFirst({ where: { id: assignmentId }, select: { errandId: true } });
    if (!found) return false;
    try {
      return (await this.reopen(found.errandId, assignmentId, { outcome: 'TIMED_OUT' })) !== undefined;
    } catch (error) {
      this.logger.error(`Could not time out assignment ${assignmentId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** The sweeper's batch: pending assignments whose deadline has passed (database clock). */
  async expireDue(limit = 100): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM assignments
      WHERE status = 'PENDING_ACCEPTANCE'::"AssignmentStatus" AND deleted_at IS NULL
        AND acceptance_deadline <= clock_timestamp()
      ORDER BY acceptance_deadline
      LIMIT ${limit}
    `;
    let expired = 0;
    for (const { id } of due) {
      if (await this.expireIfDue(id)) expired += 1;
    }
    return expired;
  }

  /**
   * Decline and timeout share one path: the assignment ends, the selected offer closes, and the
   * errand returns to OPEN (or EXPIRED). Returns undefined when a timeout finds nothing due.
   */
  private async reopen(
    errandId: string,
    assignmentId: string,
    options: { runnerId?: string; outcome: 'DECLINED' | 'TIMED_OUT' },
  ): Promise<Assignment | undefined> {
    const timeout = options.outcome === 'TIMED_OUT';
    let result: Assignment | undefined;
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.errandState.transition(tx, {
          errandId,
          to: 'OPEN',
          expectedFrom: 'RUNNER_SELECTED',
          actor: timeout ? { type: 'SYSTEM' } : { type: 'RUNNER', id: options.runnerId },
          reason: timeout ? 'The acceptance window ended.' : 'Runner declined the assignment.',
          assignmentHandled: true,
          apply: async (inner, errand) => {
            const row = await this.lockPending(inner, assignmentId, options.runnerId);
            if (timeout && row.within_deadline) {
              throw new NotDue();
            }
            const now = errand.db_now;
            result = await inner.assignment.update({
              where: { id: assignmentId },
              data: timeout
                ? { status: 'TIMED_OUT', timedOutAt: now, version: { increment: 1 } }
                : { status: 'DECLINED', declinedAt: now, version: { increment: 1 } },
            });
            await this.offers.closeSelected(inner, result.selectedOfferId, timeout ? 'ASSIGNMENT_ACCEPTANCE_TIMEOUT' : 'ASSIGNMENT_DECLINED');
            await this.publish(
              inner,
              timeout ? 'assignment.timed_out' : 'assignment.declined',
              result,
              timeout ? { type: 'SYSTEM' } : { type: 'USER', id: options.runnerId },
              { outcome: options.outcome },
            );
          },
        });
      });
    } catch (error) {
      if (error instanceof NotDue) return undefined;
      throw error;
    }
    return result;
  }

  /** The errand id of an assignment the caller is the runner of; anyone else gets "not found". */
  private async errandIdOf(assignmentId: string, runnerId: string): Promise<string> {
    const found = await this.prisma.assignment.findFirst({ where: { id: assignmentId, runnerId }, select: { errandId: true } });
    if (!found) throw DomainException.of(RESOURCE_NOT_FOUND);
    return found.errandId;
  }

  /** Lock the assignment (the errand is already locked) and require it to be pending. */
  private async lockPending(tx: Prisma.TransactionClient, assignmentId: string, runnerId?: string) {
    const rows = await tx.$queryRaw<Array<{ id: string; runner_id: string; status: string; within_deadline: boolean }>>`
      SELECT id::text, runner_id::text, status::text AS status,
             (acceptance_deadline > clock_timestamp()) AS within_deadline
      FROM assignments WHERE id = ${assignmentId}::uuid AND deleted_at IS NULL FOR UPDATE
    `;
    const row = rows[0];
    if (!row || (runnerId && row.runner_id !== runnerId)) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (row.status !== 'PENDING_ACCEPTANCE') {
      throw DomainException.of(ASSIGNMENT_INVALID_STATE, { details: { status: row.status } });
    }
    return row;
  }

  private async publish(
    tx: Prisma.TransactionClient,
    eventType: string,
    row: Assignment,
    actor: { type: 'USER' | 'SYSTEM'; id?: string },
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.outbox.add(tx, {
      eventType,
      aggregateType: 'assignment',
      aggregateId: row.id,
      payload: {
        assignmentId: row.id,
        errandId: row.errandId,
        requesterId: row.requesterId,
        runnerId: row.runnerId,
        offerId: row.selectedOfferId,
        status: row.status,
        agreedAmountMinor: Number(row.agreedAmountMinor),
        actorType: actor.type === 'SYSTEM' ? 'SYSTEM' : 'RUNNER',
        actorId: actor.id ?? null,
        ...extra,
      },
    });
    await this.audit.recordInTransaction(tx, {
      actorType: actor.type === 'SYSTEM' ? AuditActorType.SYSTEM : AuditActorType.USER,
      actorId: actor.id,
      action: eventType,
      entityType: 'assignment',
      entityId: row.id,
      after: { status: row.status, version: row.version },
      metadata: { errandId: row.errandId, ...extra },
    });
  }

  /**
   * The assignment and its errand as the caller may see them (Backend PRD 9.4, 14.3, 17.1).
   * Anyone who is not a party gets "not found".
   *
   *   requester                     everything, including exact locations and contacts
   *   runner, PENDING_ACCEPTANCE    approximate area and non-sensitive details only
   *   runner, ACCEPTED              exact locations and contacts
   *   runner, any other status      approximate only: a declined, timed out, cancelled or
   *                                 completed assignment no longer opens exact data
   */
  async getForParty(userId: string, assignmentId: string): Promise<AssignmentDetailDto> {
    const row = await this.prisma.assignment.findFirst({
      where: { id: assignmentId, OR: [{ requesterId: userId }, { runnerId: userId }] },
    });
    if (!row) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    const role = row.requesterId === userId ? 'REQUESTER' : 'RUNNER';
    const exact = role === 'REQUESTER' || row.status === 'ACCEPTED';
    const [errand, dispute] = await Promise.all([
      this.errandViews.forAssignedRunner(this.prisma, row.errandId, exact),
      this.prisma.dispute.findFirst({
        where: { assignmentId: row.id, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      }),
    ]);
    return { ...toAssignmentDto(row), role, disputeId: dispute?.id ?? null, errand: errand as unknown as AssignedErrandDto };
  }
}

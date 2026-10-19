import { Injectable } from '@nestjs/common';
import { AuditActorType, Prisma } from '@prisma/client';
import type { NegotiationMessageType, Offer, OfferCloseReason, OfferStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { lockRow } from '../database/lock-row.helper.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  ERRAND_INVALID_STATE,
  FORBIDDEN,
  OFFER_ALREADY_EXISTS,
  OFFER_AWAITING_RUNNER,
  OFFER_INVALID_STATE,
  OFFER_NEEDS_RECONFIRMATION,
  OFFER_NOT_ELIGIBLE,
  OFFER_ROUND_LIMIT_REACHED,
  OFFER_VERSION_MISMATCH,
  RESOURCE_NOT_FOUND,
  VALIDATION_ERROR,
} from '../common/constants/error-codes.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { EntitlementService } from '../entitlements/entitlement.service.js';
import { RunnerEligibilityService } from '../runner/runner-eligibility.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { ConversationService } from '../messaging/conversation.service.js';
import { errandGeographySql, runnerCoverageSql } from '../geography/geography.service.js';

export type { OfferStatus, OfferCloseReason };
export type AwaitingParty = 'RUNNER' | 'REQUESTER' | 'NONE';
type Party = 'RUNNER' | 'REQUESTER';

export interface OfferRecord {
  id: string;
  errandId: string;
  runnerId: string;
  requesterId: string;
  amountMinor: number;
  durationMinutes: number;
  status: OfferStatus;
  awaitingParty: AwaitingParty;
  version: number;
  needsReconfirmation: boolean;
  closeReason?: OfferCloseReason;
  conversationId?: string;
  createdAt: Date;
  updatedAt: Date;
  availabilityConfirmedAt?: Date;
  message?: string;
}

export interface SubmitOfferInput {
  errandId: string;
  runnerId: string;
  amountMinor: number;
  durationMinutes: number;
  availabilityConfirmed: boolean;
  message?: string;
}

export interface OfferTermsInput {
  amountMinor: number;
  durationMinutes: number;
  message?: string;
  expectedVersion?: number;
}

interface LockedErrand {
  id: string;
  requester_id: string;
  status: string;
  past_expiry: boolean;
}

/**
 * Offers and negotiation (Backend PRD 13). The database is the only source of truth: every
 * operation runs in one transaction, locks the offer row (`FOR UPDATE`), re-checks state, and
 * writes the offer change, its negotiation event, an audit row and an outbox event together.
 *
 * Errand lock order (shared with the errand state machine): errand first, then offers. An offer
 * operation locks only the offer, because closing offers happens under the errand lock and
 * touches the offer row, so a committed close is always seen by the next offer operation.
 */
@Injectable()
export class OfferService {
  constructor(
    private readonly config: BusinessConfigService,
    private readonly entitlement: EntitlementService,
    private readonly eligibility: RunnerEligibilityService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly conversations: ConversationService,
  ) {}

  // ---- Submit ----

  async submitOffer(input: SubmitOfferInput): Promise<OfferRecord> {
    const { errandId, runnerId, amountMinor, durationMinutes } = input;
    if (!input.availabilityConfirmed) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Availability must be confirmed before submitting an offer.',
        details: { field: 'availabilityConfirmed' },
      });
    }
    await this.assertTermsInBounds(amountMinor, durationMinutes);
    await this.eligibility.assertCanOffer(runnerId);
    // Everything that needs the pool is read before the transaction: parallel submits hold every
    // connection while they wait on the counter lock, and must not need another one.
    const maxOpenOffers = await this.config.get('MAX_OPEN_OFFERS_PER_RUNNER');
    const allowance = await this.entitlement.offerAllowance(runnerId);
    const interstateEnabled = await this.config.get('INTERSTATE_ERRANDS_ENABLED');

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // A shared lock: offers on one errand do not queue behind each other, but a cancel or
        // expiry (which takes FOR UPDATE) waits for in-flight offers and then closes them.
        const errand = await this.readErrand(tx, errandId, 'FOR SHARE');
        if (!errand || errand.status === 'DRAFT') {
          throw DomainException.of(RESOURCE_NOT_FOUND);
        }
        if (errand.requester_id === runnerId) {
          throw DomainException.of(OFFER_NOT_ELIGIBLE, {
            message: 'You cannot make an offer on your own errand.',
            details: { reasons: ['OWN_ERRAND'] },
          });
        }
        if (errand.status !== 'OPEN' || errand.past_expiry) {
          throw DomainException.of(ERRAND_INVALID_STATE, {
            message: 'This errand is no longer accepting offers.',
            details: { status: errand.past_expiry ? 'EXPIRED' : errand.status },
          });
        }
        const blocked = await tx.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok FROM blocks b
          WHERE b.deleted_at IS NULL
            AND ((b.blocker_id = ${runnerId}::uuid AND b.blocked_id = ${errand.requester_id}::uuid)
              OR (b.blocker_id = ${errand.requester_id}::uuid AND b.blocked_id = ${runnerId}::uuid))
          LIMIT 1
        `;
        if (blocked.length > 0) {
          throw DomainException.of(RESOURCE_NOT_FOUND);
        }

        const covered = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT e.id::text FROM errands e
          JOIN runner_profiles me ON me.user_id = ${runnerId}::uuid AND me.deleted_at IS NULL
          WHERE e.id = ${errandId}::uuid
            AND ${errandGeographySql(interstateEnabled)} AND ${runnerCoverageSql('me')}
            AND NOT (e.category_id = ANY(me.excluded_category_ids))
          FOR SHARE OF me
        `);
        if (covered.length === 0) {
          throw DomainException.of(OFFER_NOT_ELIGIBLE, { details: { reasons: ['OUTSIDE_OPERATING_AREA'] } });
        }

        // Locks the runner's daily counter row: from here on this runner's submits are serial.
        await this.entitlement.reserveOffer(tx, runnerId, allowance);

        const open = await tx.offer.count({ where: { runnerId, status: 'ACTIVE' } });
        if (open >= maxOpenOffers) {
          throw DomainException.of(OFFER_NOT_ELIGIBLE, {
            message: 'You have reached the open-offer limit.',
            details: { reasons: ['OPEN_OFFER_CAP'], maxOpenOffers },
          });
        }
        const existing = await tx.offer.findFirst({ where: { errandId, runnerId, status: 'ACTIVE' }, select: { id: true } });
        if (existing) {
          throw DomainException.of(OFFER_ALREADY_EXISTS, { details: { errandId, runnerId } });
        }

        const now = await this.dbNow(tx);
        const offer = await tx.offer.create({
          data: {
            errandId,
            runnerId,
            requesterId: errand.requester_id,
            amountMinor: BigInt(amountMinor),
            durationMinutes,
            availabilityConfirmedAt: now,
            message: input.message,
            status: 'ACTIVE',
            awaitingParty: 'REQUESTER',
            version: 0,
          },
        });
        await this.recordEvent(tx, offer, runnerId, 'INITIAL_OFFER', offer.version, {
          amountMinor,
          durationMinutes,
          message: input.message,
        });
        await tx.$executeRaw`UPDATE errands SET offer_count = offer_count + 1 WHERE id = ${errandId}::uuid`;
        // The conversation opens with the first offer, in the same transaction (Backend PRD 18.1).
        const conversationId = await this.conversations.ensureForOffer(tx, {
          errandId,
          requesterId: errand.requester_id,
          runnerId,
          offerId: offer.id,
        });
        const linked = await tx.offer.update({ where: { id: offer.id }, data: { conversationId } });
        await this.publish(tx, 'offer.created', linked, runnerId, 'offer.submitted', { conversationId });
        return linked;
      });
      return this.toRecord(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw DomainException.of(OFFER_ALREADY_EXISTS, { details: { errandId, runnerId } });
      }
      throw error;
    }
  }

  async getNegotiation(offerId: string, userId: string): Promise<{
    id: string;
    errandId: string;
    runnerId: string;
    requesterId: string;
    amountMinor: number;
    durationMinutes: number;
    status: OfferStatus;
    awaitingParty: AwaitingParty;
    version: number;
    needsReconfirmation: boolean;
    closeReason: OfferCloseReason | null;
    conversationId: string | null;
    createdAt: Date;
    updatedAt: Date;
    availabilityConfirmedAt: Date | null;
    message: string | null;
    assignmentId: string | null;
    errandTitle: string;
    /** Counter-offers used so far, and how many this negotiation allows. */
    roundsUsed: number;
    roundsLimit: number;
    history: Array<{
      id: string;
      type: NegotiationMessageType;
      actorUserId: string;
      amountMinor: number | null;
      durationMinutes: number | null;
      message: string | null;
      createdAt: Date;
    }>;
  }> {
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, OR: [{ runnerId: userId }, { requesterId: userId }] },
      include: {
        errand: { select: { title: true } },
        negotiationEvents: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        assignments: { select: { id: true }, take: 1 },
      },
    });
    if (!offer) throw DomainException.of(RESOURCE_NOT_FOUND);
    return {
      id: offer.id,
      errandId: offer.errandId,
      runnerId: offer.runnerId,
      requesterId: offer.requesterId,
      amountMinor: Number(offer.amountMinor),
      durationMinutes: offer.durationMinutes,
      status: offer.status,
      awaitingParty: offer.awaitingParty,
      version: offer.version,
      needsReconfirmation: offer.needsReconfirmation,
      closeReason: offer.closeReason,
      conversationId: offer.conversationId,
      createdAt: offer.createdAt,
      updatedAt: offer.updatedAt,
      availabilityConfirmedAt: offer.availabilityConfirmedAt,
      message: offer.message,
      assignmentId: offer.assignments[0]?.id ?? null,
      errandTitle: offer.errand.title,
      roundsUsed: offer.counterRounds,
      roundsLimit: await this.config.get('MAX_NEGOTIATION_ROUNDS'),
      history: offer.negotiationEvents.map((event) => ({
        id: event.id,
        type: event.messageType,
        actorUserId: event.actorUserId,
        amountMinor: event.proposedAmountMinor === null ? null : Number(event.proposedAmountMinor),
        durationMinutes: event.proposedDurationMinutes,
        message: event.message,
        createdAt: event.createdAt,
      })),
    };
  }

  // ---- Negotiation ----

  /** The runner revises their own offer while it waits on the requester. Not counted against the limit. */
  edit(offerId: string, userId: string, input: OfferTermsInput): Promise<OfferRecord> {
    return this.mutate(offerId, userId, 'edit', async (tx, offer, party) => {
      this.assertParty(party, 'RUNNER');
      this.assertActive(offer, input.expectedVersion);
      this.assertNoReconfirmation(offer);
      if (offer.awaitingParty === 'RUNNER') {
        throw DomainException.of(OFFER_INVALID_STATE, {
          message: 'Respond to the counter-offer instead of editing.',
          details: { offerId, awaitingParty: offer.awaitingParty },
        });
      }
      await this.assertErrandOpen(tx, offer.errandId);
      await this.assertTermsInBounds(input.amountMinor, input.durationMinutes);
      return this.applyTerms(tx, offer, userId, input, 'REQUESTER');
    });
  }

  /** A counter on the actor's own turn: the requester when waiting on them, the runner when waiting on the runner. */
  counterOffer(offerId: string, userId: string, input: OfferTermsInput): Promise<OfferRecord> {
    return this.mutate(offerId, userId, 'counter', async (tx, offer, party) => {
      this.assertActive(offer, input.expectedVersion);
      this.assertNoReconfirmation(offer);
      if (offer.awaitingParty !== party) {
        throw DomainException.of(OFFER_INVALID_STATE, {
          message: `It is not the ${party.toLowerCase()}'s turn to negotiate this offer.`,
          details: { offerId, awaitingParty: offer.awaitingParty, actor: party },
        });
      }
      const roundsLimit = await this.config.get('MAX_NEGOTIATION_ROUNDS');
      if (offer.counterRounds >= roundsLimit) {
        throw DomainException.of(OFFER_ROUND_LIMIT_REACHED, {
          details: { offerId, roundsUsed: offer.counterRounds, roundsLimit },
        });
      }
      await this.assertErrandOpen(tx, offer.errandId);
      await this.assertTermsInBounds(input.amountMinor, input.durationMinutes);
      return this.applyTerms(tx, offer, userId, input, party === 'RUNNER' ? 'REQUESTER' : 'RUNNER', true);
    });
  }

  /** The runner accepts the requester's counter: the amount is agreed and the requester may select. */
  acceptCounter(offerId: string, userId: string, expectedVersion?: number): Promise<OfferRecord> {
    return this.mutate(offerId, userId, 'accept_counter', async (tx, offer, party) => {
      this.assertParty(party, 'RUNNER');
      this.assertActive(offer, expectedVersion);
      this.assertNoReconfirmation(offer);
      if (offer.awaitingParty !== 'RUNNER') {
        throw DomainException.of(OFFER_INVALID_STATE, {
          message: 'There is no counter-offer waiting for you.',
          details: { offerId, awaitingParty: offer.awaitingParty },
        });
      }
      await this.assertErrandOpen(tx, offer.errandId);
      const updated = await tx.offer.update({
        where: { id: offer.id },
        data: { awaitingParty: 'NONE', version: { increment: 1 } },
      });
      await this.recordEvent(tx, updated, userId, 'ACCEPT', updated.version, {
        amountMinor: Number(updated.amountMinor),
        durationMinutes: updated.durationMinutes,
      });
      return updated;
    });
  }

  /** The requester declines an offer. Allowed at any point before selection, whoever holds the turn. */
  rejectOffer(offerId: string, userId: string, expectedVersion?: number): Promise<OfferRecord> {
    return this.mutate(offerId, userId, 'reject', async (tx, offer, party) => {
      this.assertParty(party, 'REQUESTER');
      this.assertActive(offer, expectedVersion);
      const now = await this.dbNow(tx);
      const updated = await tx.offer.update({
        where: { id: offer.id },
        data: {
          status: 'REJECTED',
          closeReason: 'REQUESTER_REJECTED',
          awaitingParty: 'NONE',
          closedAt: now,
          version: { increment: 1 },
        },
      });
      await this.recordEvent(tx, updated, userId, 'REJECT', updated.version);
      return updated;
    });
  }

  /** The runner pulls the offer. It still counts for the day, so resubmitting cannot dodge the limit. */
  withdraw(offerId: string, userId: string): Promise<OfferRecord> {
    return this.mutate(offerId, userId, 'withdraw', async (tx, offer, party) => {
      this.assertParty(party, 'RUNNER');
      this.assertActive(offer);
      const now = await this.dbNow(tx);
      const updated = await tx.offer.update({
        where: { id: offer.id },
        data: {
          status: 'WITHDRAWN',
          closeReason: 'RUNNER_WITHDREW',
          awaitingParty: 'NONE',
          withdrawnAt: now,
          closedAt: now,
          version: { increment: 1 },
        },
      });
      await this.recordEvent(tx, updated, userId, 'WITHDRAW', updated.version);
      return updated;
    });
  }

  /** After a material errand edit the runner confirms the offer still stands (Backend PRD 11.5). */
  async reconfirmOffer(offerId: string, userId: string, expectedVersion?: number): Promise<OfferRecord> {
    // Only the offer's own runner is checked here; anyone else gets the same answer as for a missing offer.
    const own = await this.prisma.offer.findFirst({ where: { id: offerId, runnerId: userId }, select: { id: true } });
    if (own) {
      await this.eligibility.assertCanOffer(userId);
    }
    return this.mutate(offerId, userId, 'reconfirm', async (tx, offer, party) => {
      this.assertParty(party, 'RUNNER');
      this.assertActive(offer, expectedVersion);
      if (!offer.needsReconfirmation) {
        throw DomainException.of(OFFER_INVALID_STATE, {
          message: 'This offer does not need reconfirmation.',
          details: { offerId },
        });
      }
      await this.assertErrandOpen(tx, offer.errandId);
      const updated = await tx.offer.update({
        where: { id: offer.id },
        data: { needsReconfirmation: false, awaitingParty: 'REQUESTER', version: { increment: 1 } },
      });
      await this.recordEvent(tx, updated, userId, 'SYSTEM_EVENT', updated.version, {
        amountMinor: Number(updated.amountMinor),
        durationMinutes: updated.durationMinutes,
        message: 'RECONFIRMED',
      });
      return updated;
    });
  }

  // ---- Lifecycle hooks (called inside another module's transaction) ----

  /**
   * Flag every live offer on the errand after a material edit. Called in the editing transaction,
   * so an edit and its flags commit or roll back together. Returns how many offers were flagged.
   */
  async flagForReconfirmation(tx: Prisma.TransactionClient, errandId: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE offers
      SET needs_reconfirmation = true, awaiting_party = 'RUNNER'::"OfferAwaitingParty",
          version = version + 1, updated_at = clock_timestamp()
      WHERE errand_id = ${errandId}::uuid AND status = 'ACTIVE'::"OfferStatus" AND deleted_at IS NULL
        AND needs_reconfirmation = false
      RETURNING id::text
    `;
    for (const { id } of rows) {
      const offer = await tx.offer.findUniqueOrThrow({ where: { id } });
      await this.recordEvent(tx, offer, offer.requesterId, 'SYSTEM_EVENT', offer.version, {
        amountMinor: Number(offer.amountMinor),
        durationMinutes: offer.durationMinutes,
        message: 'ERRAND_EDITED',
      });
      await this.publish(tx, 'offer.updated', offer, offer.requesterId, 'offer.flagged_for_reconfirmation');
    }
    return rows.length;
  }

  /**
   * Close every live offer when the errand ends (cancelled or expired). Runs in the errand state
   * machine's transaction, so offers and errand change together.
   */
  async closeForErrand(
    tx: Prisma.TransactionClient,
    errandId: string,
    reason: Extract<OfferCloseReason, 'ERRAND_CANCELLED' | 'ERRAND_EXPIRED' | 'ADMIN_CLOSED'>,
  ): Promise<number> {
    const status: OfferStatus = reason === 'ERRAND_EXPIRED' ? 'EXPIRED' : 'CLOSED';
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE offers
      SET status = ${status}::"OfferStatus", close_reason = ${reason}::"OfferCloseReason",
          awaiting_party = 'NONE'::"OfferAwaitingParty", closed_at = clock_timestamp(),
          version = version + 1, updated_at = clock_timestamp()
      WHERE errand_id = ${errandId}::uuid AND status = 'ACTIVE'::"OfferStatus" AND deleted_at IS NULL
      RETURNING id::text
    `;
    for (const { id } of rows) {
      const offer = await tx.offer.findUniqueOrThrow({ where: { id } });
      await this.recordEvent(tx, offer, offer.requesterId, 'SYSTEM_EVENT', offer.version, {
        amountMinor: Number(offer.amountMinor),
        durationMinutes: offer.durationMinutes,
        message: reason,
      });
      await this.publish(tx, 'offer.closed', offer, offer.requesterId, 'offer.closed');
    }
    return rows.length;
  }

  /**
   * An admin closes one active offer (spam, a policy breach, a support case). The runner and the
   * requester are told through the normal `offer.closed` event.
   */
  async adminClose(offerId: string, adminId: string, reason: string): Promise<Offer> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await lockRow<{ id: string }>(tx, 'offers', offerId, 'id');
      if (!locked) {
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE offers
        SET status = 'CLOSED'::"OfferStatus", close_reason = 'ADMIN_CLOSED'::"OfferCloseReason",
            awaiting_party = 'NONE'::"OfferAwaitingParty", closed_at = clock_timestamp(),
            version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${offerId}::uuid AND status = 'ACTIVE'::"OfferStatus" AND deleted_at IS NULL
        RETURNING id::text
      `;
      if (rows.length === 0) {
        throw DomainException.of(OFFER_INVALID_STATE, { message: 'Only an active offer can be closed.' });
      }
      const offer = await tx.offer.findUniqueOrThrow({ where: { id: offerId } });
      // The history row names the requester as the actor of record (a system event): admins are not users.
      await this.recordEvent(tx, offer, offer.requesterId, 'SYSTEM_EVENT', offer.version, {
        amountMinor: Number(offer.amountMinor),
        durationMinutes: offer.durationMinutes,
        message: `ADMIN_CLOSED by ${adminId}: ${reason}`.slice(0, 500),
      });
      await this.publish(tx, 'offer.closed', offer, offer.requesterId, 'offer.closed');
      return offer;
    });
  }

  // ---- Selection (called by the assignment module inside its transaction) ----

  /**
   * Lock the offer and check it can be selected (Backend PRD 14.2 step 3): it belongs to the
   * errand, is `ACTIVE`, is not flagged for reconfirmation, is not waiting on the runner, and
   * still has the version the requester saw. The caller already holds the errand lock.
   */
  async lockForSelection(tx: Prisma.TransactionClient, offerId: string, errandId: string, expectedVersion: number): Promise<Offer> {
    const locked = await lockRow<{ id: string }>(tx, 'offers', offerId, 'id');
    const offer = locked ? await tx.offer.findFirst({ where: { id: offerId } }) : null;
    if (!offer || offer.errandId !== errandId) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (offer.status !== 'ACTIVE') {
      throw DomainException.of(OFFER_INVALID_STATE, {
        message: 'This offer is no longer active.',
        details: { offerId, status: offer.status },
      });
    }
    if (offer.version !== expectedVersion) {
      throw DomainException.of(OFFER_VERSION_MISMATCH, {
        details: { offerId, actualVersion: offer.version, expectedVersion },
      });
    }
    this.assertNoReconfirmation(offer);
    if (offer.awaitingParty === 'RUNNER') {
      throw DomainException.of(OFFER_AWAITING_RUNNER, { details: { offerId } });
    }
    return offer;
  }

  /** The chosen offer becomes `SELECTED`; the requester's choice is an `ACCEPT` event. */
  async markSelected(tx: Prisma.TransactionClient, offer: Offer, requesterId: string): Promise<Offer> {
    const now = await this.dbNow(tx);
    const updated = await tx.offer.update({
      where: { id: offer.id },
      data: { status: 'SELECTED', awaitingParty: 'NONE', selectedAt: now, version: { increment: 1 } },
    });
    await this.recordEvent(tx, updated, requesterId, 'ACCEPT', updated.version, {
      amountMinor: Number(updated.amountMinor),
      durationMinutes: updated.durationMinutes,
      message: 'SELECTED',
    });
    await this.publish(tx, 'offer.updated', updated, requesterId, 'offer.selected');
    return updated;
  }

  /**
   * The selected offer ends without being served (decline, acceptance timeout, errand cancelled
   * while pending). It is closed, never restored (Backend PRD 13.5). A no-op if it is not `SELECTED`.
   */
  async closeSelected(
    tx: Prisma.TransactionClient,
    offerId: string,
    reason: Extract<OfferCloseReason, 'ASSIGNMENT_DECLINED' | 'ASSIGNMENT_ACCEPTANCE_TIMEOUT' | 'ERRAND_CANCELLED'>,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE offers
      SET status = 'CLOSED'::"OfferStatus", close_reason = ${reason}::"OfferCloseReason",
          awaiting_party = 'NONE'::"OfferAwaitingParty", closed_at = clock_timestamp(),
          version = version + 1, updated_at = clock_timestamp()
      WHERE id = ${offerId}::uuid AND status = 'SELECTED'::"OfferStatus" AND deleted_at IS NULL
      RETURNING id::text
    `;
    for (const { id } of rows) {
      const offer = await tx.offer.findUniqueOrThrow({ where: { id } });
      await this.recordEvent(tx, offer, offer.requesterId, 'SYSTEM_EVENT', offer.version, {
        amountMinor: Number(offer.amountMinor),
        durationMinutes: offer.durationMinutes,
        message: reason,
      });
      await this.publish(tx, 'offer.closed', offer, offer.requesterId, 'offer.closed');
    }
  }

  /**
   * An accepted `AMOUNT` change request after selection (Backend PRD 15.6): the offer carries the
   * new amount and the history shows who proposed it and who agreed, so the offer, the assignment
   * and the negotiation log agree.
   */
  async recordAgreedAmountChange(
    tx: Prisma.TransactionClient,
    offerId: string,
    amountMinor: number,
    proposerId: string,
    responderId: string,
  ): Promise<void> {
    const updated = await tx.offer.update({
      where: { id: offerId },
      data: { amountMinor: BigInt(amountMinor), version: { increment: 2 } },
    });
    const durationMinutes = updated.durationMinutes;
    await this.recordEvent(tx, updated, proposerId, 'COUNTER_OFFER', updated.version - 1, {
      amountMinor,
      durationMinutes,
      message: 'CHANGE_REQUEST',
    });
    await this.recordEvent(tx, updated, responderId, 'ACCEPT', updated.version, {
      amountMinor,
      durationMinutes,
      message: 'CHANGE_REQUEST',
    });
  }

  /** Every other live offer on the errand closes when one is selected (PRD 14.2 step 7). */
  async closeOthersOnSelection(tx: Prisma.TransactionClient, errandId: string, selectedOfferId: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE offers
      SET status = 'CLOSED'::"OfferStatus", close_reason = 'RUNNER_SELECTED'::"OfferCloseReason",
          awaiting_party = 'NONE'::"OfferAwaitingParty", closed_at = clock_timestamp(),
          version = version + 1, updated_at = clock_timestamp()
      WHERE errand_id = ${errandId}::uuid AND id <> ${selectedOfferId}::uuid
        AND status = 'ACTIVE'::"OfferStatus" AND deleted_at IS NULL
      RETURNING id::text
    `;
    for (const { id } of rows) {
      const offer = await tx.offer.findUniqueOrThrow({ where: { id } });
      await this.recordEvent(tx, offer, offer.requesterId, 'SYSTEM_EVENT', offer.version, {
        amountMinor: Number(offer.amountMinor),
        durationMinutes: offer.durationMinutes,
        message: 'RUNNER_SELECTED',
      });
      await this.publish(tx, 'offer.closed', offer, offer.requesterId, 'offer.closed');
    }
    return rows.length;
  }

  // ---- Internals ----

  /** Lock the offer, resolve the caller's party, run the change, audit and publish, return the record. */
  private async mutate(
    offerId: string,
    userId: string,
    action: string,
    work: (tx: Prisma.TransactionClient, offer: Offer, party: Party) => Promise<Offer>,
  ): Promise<OfferRecord> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const locked = await lockRow<{ id: string }>(tx, 'offers', offerId, 'id');
      const offer = locked ? await tx.offer.findFirst({ where: { id: offerId } }) : null;
      // Not a party: the same answer as a missing offer, so ids cannot be probed.
      const party: Party | null = !offer ? null : offer.runnerId === userId ? 'RUNNER' : offer.requesterId === userId ? 'REQUESTER' : null;
      if (!offer || !party) {
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }
      const result = await work(tx, offer, party);
      await this.publish(tx, eventTypeFor(action), result, userId, `offer.${action}`, { before: offer.status });
      return result;
    });
    return this.toRecord(updated);
  }

  private async applyTerms(
    tx: Prisma.TransactionClient,
    offer: Offer,
    actorId: string,
    input: OfferTermsInput,
    next: Party,
    /** True for a counter-offer, which uses up a negotiation round. A runner's edit does not. */
    countsAsRound = false,
  ): Promise<Offer> {
    const updated = await tx.offer.update({
      where: { id: offer.id },
      data: {
        amountMinor: BigInt(input.amountMinor),
        durationMinutes: input.durationMinutes,
        message: input.message ?? offer.message,
        awaitingParty: next,
        ...(countsAsRound ? { counterRounds: { increment: 1 } } : {}),
        version: { increment: 1 },
      },
    });
    await this.recordEvent(tx, updated, actorId, 'COUNTER_OFFER', updated.version, {
      amountMinor: input.amountMinor,
      durationMinutes: input.durationMinutes,
      message: input.message,
    });
    return updated;
  }

  private assertParty(actual: Party, required: Party): void {
    if (actual !== required) {
      throw DomainException.of(FORBIDDEN, {
        message: required === 'RUNNER' ? 'Only the runner can do this.' : 'Only the requester can do this.',
      });
    }
  }

  private assertActive(offer: Offer, expectedVersion?: number): void {
    if (offer.status !== 'ACTIVE') {
      throw DomainException.of(OFFER_INVALID_STATE, {
        message: 'This offer is no longer active.',
        details: { offerId: offer.id, status: offer.status },
      });
    }
    if (expectedVersion !== undefined && offer.version !== expectedVersion) {
      throw DomainException.of(OFFER_VERSION_MISMATCH, {
        details: { offerId: offer.id, actualVersion: offer.version, expectedVersion },
      });
    }
  }

  private assertNoReconfirmation(offer: Offer): void {
    if (offer.needsReconfirmation) {
      throw DomainException.of(OFFER_NEEDS_RECONFIRMATION, { details: { offerId: offer.id } });
    }
  }

  private async assertTermsInBounds(amountMinor: number, durationMinutes: number): Promise<void> {
    const [minAmount, maxAmount, minDuration, maxDuration] = await Promise.all([
      this.config.get('OFFER_MIN_AMOUNT'),
      this.config.get('OFFER_MAX_AMOUNT'),
      this.config.get('OFFER_DURATION_MIN_MINUTES'),
      this.config.get('OFFER_DURATION_MAX_MINUTES'),
    ]);
    if (!Number.isInteger(amountMinor) || amountMinor < minAmount || amountMinor > maxAmount) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Offer amount is outside the allowed range.',
        details: { field: 'amountMinor', minAmount, maxAmount },
      });
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < minDuration || durationMinutes > maxDuration) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Offer duration is outside the allowed range.',
        details: { field: 'durationMinutes', minDuration, maxDuration },
      });
    }
  }

  private async assertErrandOpen(tx: Prisma.TransactionClient, errandId: string): Promise<void> {
    const errand = await this.readErrand(tx, errandId, '');
    if (!errand || errand.status !== 'OPEN' || errand.past_expiry) {
      throw DomainException.of(ERRAND_INVALID_STATE, {
        message: 'This errand is no longer accepting offers.',
        details: { status: errand?.past_expiry ? 'EXPIRED' : errand?.status },
      });
    }
  }

  private async readErrand(tx: Prisma.TransactionClient, errandId: string, lock: '' | 'FOR SHARE'): Promise<LockedErrand | null> {
    const sql = `
      SELECT id::text, requester_id::text, status::text,
             (expires_at IS NOT NULL AND expires_at <= clock_timestamp()) AS past_expiry
      FROM errands WHERE id = $1::uuid AND deleted_at IS NULL ${lock}`;
    const rows = await tx.$queryRawUnsafe<LockedErrand[]>(sql, errandId);
    return rows[0] ?? null;
  }

  private async dbNow(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return rows[0].now;
  }

  private async recordEvent(
    tx: Prisma.TransactionClient,
    offer: Offer,
    actorUserId: string,
    messageType: NegotiationMessageType,
    resultingOfferVersion: number,
    terms: { amountMinor?: number; durationMinutes?: number; message?: string } = {},
  ): Promise<void> {
    await tx.negotiationEvent.create({
      data: {
        errandId: offer.errandId,
        offerId: offer.id,
        actorUserId,
        messageType,
        proposedAmountMinor: terms.amountMinor === undefined ? undefined : BigInt(terms.amountMinor),
        proposedDurationMinutes: terms.durationMinutes,
        currency: 'NGN',
        message: terms.message,
        resultingOfferVersion,
      },
    });
  }

  private async publish(
    tx: Prisma.TransactionClient,
    eventType: string,
    offer: Offer,
    actorId: string,
    auditAction: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.outbox.add(tx, {
      eventType,
      aggregateType: 'offer',
      aggregateId: offer.id,
      payload: {
        offerId: offer.id,
        errandId: offer.errandId,
        runnerId: offer.runnerId,
        requesterId: offer.requesterId,
        status: offer.status,
        awaitingParty: offer.awaitingParty,
        needsReconfirmation: offer.needsReconfirmation,
        amountMinor: Number(offer.amountMinor),
        durationMinutes: offer.durationMinutes,
        version: offer.version,
        actorId,
        /** What happened, for consumers that word a notification per action (offer.counter, offer.reconfirm...). */
        action: auditAction,
        closeReason: offer.closeReason ?? null,
      },
    });
    await this.audit.recordInTransaction(tx, {
      actorType: AuditActorType.USER,
      actorId,
      action: auditAction,
      entityType: 'offer',
      entityId: offer.id,
      after: { status: offer.status, awaitingParty: offer.awaitingParty, amountMinor: Number(offer.amountMinor), version: offer.version },
      reasonCode: offer.closeReason ?? undefined,
      metadata: { errandId: offer.errandId, ...extra },
    });
  }

  private toRecord(raw: Offer): OfferRecord {
    return {
      id: raw.id,
      errandId: raw.errandId,
      runnerId: raw.runnerId,
      requesterId: raw.requesterId,
      amountMinor: Number(raw.amountMinor),
      durationMinutes: raw.durationMinutes,
      status: raw.status,
      awaitingParty: raw.awaitingParty,
      version: raw.version,
      needsReconfirmation: raw.needsReconfirmation,
      closeReason: raw.closeReason ?? undefined,
      conversationId: raw.conversationId ?? undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      availabilityConfirmedAt: raw.availabilityConfirmedAt ?? undefined,
      message: raw.message ?? undefined,
    };
  }
}

/** Queue-registered event type for each negotiation action. */
function eventTypeFor(action: string): string {
  switch (action) {
    case 'withdraw':
      return 'offer.withdrawn';
    case 'reject':
      return 'offer.rejected';
    default:
      return 'offer.updated';
  }
}

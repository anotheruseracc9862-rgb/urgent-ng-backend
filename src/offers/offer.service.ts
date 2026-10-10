import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  FORBIDDEN,
  OFFER_ALREADY_EXISTS,
  OFFER_INVALID_STATE,
  OFFER_NEEDS_RECONFIRMATION,
  OFFER_NOT_ELIGIBLE,
  OFFER_VERSION_MISMATCH,
  RESOURCE_NOT_FOUND,
  VALIDATION_ERROR,
} from '../common/constants/error-codes.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { EntitlementService } from '../entitlements/entitlement.service.js';
import { OfferLimitService } from '../entitlements/offer-limit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { generateUuidV7 } from '../common/utils/uuid.helper.js';

export type OfferStatus = 'ACTIVE' | 'WITHDRAWN' | 'REJECTED' | 'SELECTED' | 'EXPIRED' | 'CLOSED';
export type AwaitingParty = 'RUNNER' | 'REQUESTER' | 'NONE';
export type OfferCloseReason =
  | 'REQUESTER_REJECTED'
  | 'RUNNER_WITHDREW'
  | 'ERRAND_CANCELLED'
  | 'ERRAND_EXPIRED'
  | 'RUNNER_SELECTED'
  | 'ASSIGNMENT_ACCEPTED'
  | 'ASSIGNMENT_DECLINED'
  | 'ASSIGNMENT_ACCEPTANCE_TIMEOUT'
  | 'ADMIN_CLOSED';

export interface ErrandOfferContext {
  id: string;
  requesterId: string;
  status: 'OPEN' | 'RUNNER_SELECTED' | 'ACCEPTED' | 'IN_PROGRESS' | 'PICKED_UP' | 'DELIVERED' | 'COMPLETED' | 'DISPUTED' | 'CANCELLED' | 'EXPIRED';
}

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
  errand: ErrandOfferContext;
  runnerId: string;
  amountMinor: number;
  durationMinutes: number;
  conversationId?: string;
  availabilityConfirmedAt?: Date;
  message?: string;
}

@Injectable()
export class OfferService {
  private readonly offers = new Map<string, OfferRecord>();
  private readonly offersByErrandRunner = new Map<string, string>();

  constructor(
    private readonly config: BusinessConfigService,
    private readonly entitlement: EntitlementService,
    private readonly offerLimit: OfferLimitService,
    @Optional() private readonly outbox?: OutboxService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async canSubmitOffer(errand: ErrandOfferContext, runnerId: string): Promise<{ allowed: boolean; reasons: string[] }> {
    const reasons: string[] = [];

    if (errand.status !== 'OPEN') {
      reasons.push('ERRAND_NOT_OPEN');
    }
    if (errand.requesterId === runnerId) {
      reasons.push('OWN_ERRAND');
    }

    if (reasons.length > 0) {
      return { allowed: false, reasons };
    }

    try {
      await this.entitlement.assertCanSubmitOffer(runnerId);
      return { allowed: true, reasons: [] };
    } catch (error) {
      if (error instanceof DomainException && error.getCode() === 'OFFER_DAILY_LIMIT_REACHED') {
        return { allowed: false, reasons: ['OFFER_DAILY_LIMIT_REACHED'] };
      }
      throw error;
    }
  }

  async submitOffer(input: SubmitOfferInput): Promise<OfferRecord> {
    const { errand, runnerId, amountMinor, durationMinutes } = input;
    const eligibility = await this.canSubmitOffer(errand, runnerId);

    if (!eligibility.allowed) {
      throw DomainException.of(OFFER_NOT_ELIGIBLE, {
        message: 'This runner is not eligible to submit an offer on this errand.',
        details: { reasons: eligibility.reasons },
      });
    }

    const [minAmount, maxAmount, minDuration, maxDuration, maxOpenOffers] = await Promise.all([
      this.config.get('OFFER_MIN_AMOUNT'),
      this.config.get('OFFER_MAX_AMOUNT'),
      this.config.get('OFFER_DURATION_MIN_MINUTES'),
      this.config.get('OFFER_DURATION_MAX_MINUTES'),
      this.config.get('MAX_OPEN_OFFERS_PER_RUNNER'),
    ]);

    if (amountMinor < minAmount || amountMinor > maxAmount) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Offer amount is outside the configured allowance.',
        details: { amountMinor, minAmount, maxAmount },
      });
    }

    if (durationMinutes < minDuration || durationMinutes > maxDuration) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Offer duration is outside the configured bounds.',
        details: { durationMinutes, minDuration, maxDuration },
      });
    }

    if (!input.availabilityConfirmedAt) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Availability must be confirmed before submitting an offer.',
        details: { field: 'availabilityConfirmedAt' },
      });
    }

    const activeForRunner = Array.from(this.offers.values()).filter(
      (offer) => offer.runnerId === runnerId && offer.status === 'ACTIVE',
    ).length;
    if (activeForRunner >= maxOpenOffers) {
      throw DomainException.of(OFFER_NOT_ELIGIBLE, {
        message: 'The runner has reached the open-offer cap.',
        details: { runnerId, maxOpenOffers, activeForRunner },
      });
    }

    const existingKey = this.keyForErrandRunner(errand.id, runnerId);
    const activeOfferId = this.offersByErrandRunner.get(existingKey);
    if (activeOfferId && this.offers.get(activeOfferId)?.status === 'ACTIVE') {
      throw DomainException.of(OFFER_ALREADY_EXISTS, {
        message: 'You already have an active offer on this errand.',
        details: { errandId: errand.id, runnerId },
      });
    }

    if (this.prisma) {
      const persisted = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.offer.findFirst({
          where: {
            errandId: errand.id,
            runnerId,
            status: 'ACTIVE',
          },
        });

        if (existing) {
          throw DomainException.of(OFFER_ALREADY_EXISTS, {
            message: 'You already have an active offer on this errand.',
            details: { errandId: errand.id, runnerId },
          });
        }

        const created = await tx.offer.create({
          data: {
            errandId: errand.id,
            runnerId,
            requesterId: errand.requesterId,
            amountMinor: BigInt(amountMinor),
            durationMinutes,
            status: 'ACTIVE',
            awaitingParty: 'REQUESTER',
            needsReconfirmation: false,
            availabilityConfirmedAt: input.availabilityConfirmedAt,
            message: input.message,
            conversationId: input.conversationId,
            version: 1,
          },
        });

        await tx.negotiationEvent.create({
          data: {
            errandId: errand.id,
            offerId: created.id,
            actorUserId: runnerId,
            messageType: 'INITIAL_OFFER',
            proposedAmountMinor: BigInt(amountMinor),
            proposedDurationMinutes: durationMinutes,
            currency: 'NGN',
            message: input.message,
            resultingOfferVersion: 1,
          },
        });

        await this.offerLimit.consume(runnerId, 1, tx);

        // Increment errand.offer_count
        await tx.$executeRaw`UPDATE errands SET offer_count = offer_count + 1 WHERE id = ${errand.id}::uuid`;

        // Publish offer.submitted event to outbox
        if (this.outbox) {
          await this.outbox.add(tx, {
            eventType: 'offer.submitted',
            aggregateType: 'offer',
            aggregateId: created.id,
            payload: {
              offerId: created.id,
              errandId: errand.id,
              runnerId,
              requesterId: errand.requesterId,
              amountMinor,
              durationMinutes,
            },
          });
        }

        return this.mapPersistedOffer(created);
      });

      this.offers.set(persisted.id, persisted);
      this.offersByErrandRunner.set(existingKey, persisted.id);
      return persisted;
    }

    const offer: OfferRecord = {
      id: generateUuidV7(),
      errandId: errand.id,
      runnerId,
      requesterId: errand.requesterId,
      amountMinor,
      durationMinutes,
      status: 'ACTIVE',
      awaitingParty: 'REQUESTER',
      version: 1,
      needsReconfirmation: false,
      closeReason: undefined,
      conversationId: input.conversationId,
      createdAt: new Date(),
      updatedAt: new Date(),
      availabilityConfirmedAt: input.availabilityConfirmedAt,
      message: input.message,
    };

    this.offers.set(offer.id, offer);
    this.offersByErrandRunner.set(existingKey, offer.id);
    await this.offerLimit.consume(runnerId, 1);
    return offer;
  }

  getOffer(offerId: string): OfferRecord | undefined {
    return this.offers.get(offerId);
  }

  getLiveOffersForErrand(errandId: string): OfferRecord[] {
    return Array.from(this.offers.values()).filter((offer) => offer.errandId === errandId && offer.status === 'ACTIVE');
  }

  flagForReconfirmation(errandId: string): number {
    let flagged = 0;
    for (const offer of this.offers.values()) {
      if (offer.errandId === errandId && offer.status === 'ACTIVE') {
        offer.needsReconfirmation = true;
        offer.awaitingParty = 'RUNNER';
        offer.updatedAt = new Date();
        flagged += 1;
      }
    }
    return flagged;
  }

  async reconfirmOffer(offerId: string, expectedVersion?: number, runnerId?: string): Promise<OfferRecord> {
    if (this.prisma) {
      const persisted = await this.prisma.$transaction(async (tx) => {
        const offer = await tx.offer.findUnique({ where: { id: offerId } });
        if (!offer) {
          throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Offer not found.' });
        }
        if (runnerId && offer.runnerId !== runnerId) {
          throw DomainException.of(FORBIDDEN, {
            message: 'Only the runner that submitted this offer can reconfirm it.',
            details: { offerId, runnerId, ownerId: offer.runnerId },
          });
        }
        if (offer.status !== 'ACTIVE') {
          throw DomainException.of(OFFER_INVALID_STATE, {
            message: 'Only an active offer can be reconfirmed.',
            details: { offerId, status: offer.status },
          });
        }
        if (expectedVersion !== undefined && offer.version !== expectedVersion) {
          throw DomainException.of(OFFER_VERSION_MISMATCH, {
            message: 'This offer has changed since it was last reviewed.',
            details: { offerId, actualVersion: offer.version, expectedVersion },
          });
        }
        if (!offer.needsReconfirmation) {
          throw DomainException.of(OFFER_NEEDS_RECONFIRMATION, {
            message: 'This offer does not need reconfirmation.',
            details: { offerId },
          });
        }

        const updated = await tx.offer.update({
          where: { id: offerId },
          data: {
            needsReconfirmation: false,
            awaitingParty: 'REQUESTER',
            version: { increment: 1 },
          },
        });

        return this.mapPersistedOffer(updated);
      });

      this.offers.set(persisted.id, persisted);
      return persisted;
    }

    const offer = this.offers.get(offerId);
    if (!offer) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Offer not found.' });
    }
    if (runnerId && offer.runnerId !== runnerId) {
      throw DomainException.of(FORBIDDEN, {
        message: 'Only the runner that submitted this offer can reconfirm it.',
        details: { offerId, runnerId, ownerId: offer.runnerId },
      });
    }
    if (offer.status !== 'ACTIVE') {
      throw DomainException.of(OFFER_INVALID_STATE, {
        message: 'Only an active offer can be reconfirmed.',
        details: { offerId, status: offer.status },
      });
    }
    if (expectedVersion !== undefined && offer.version !== expectedVersion) {
      throw DomainException.of(OFFER_VERSION_MISMATCH, {
        message: 'This offer has changed since it was last reviewed.',
        details: { offerId, actualVersion: offer.version, expectedVersion },
      });
    }
    if (!offer.needsReconfirmation) {
      throw DomainException.of(OFFER_NEEDS_RECONFIRMATION, {
        message: 'This offer does not need reconfirmation.',
        details: { offerId },
      });
    }

    offer.needsReconfirmation = false;
    offer.awaitingParty = 'REQUESTER';
    offer.version += 1;
    offer.updatedAt = new Date();
    return offer;
  }

  async counterOffer(
    offerId: string,
    actor: 'RUNNER' | 'REQUESTER',
    amountMinor: number,
    durationMinutes: number,
    message?: string,
    expectedVersion?: number,
  ): Promise<OfferRecord> {
    if (this.prisma) {
      const persisted = await this.prisma.$transaction(async (tx) => {
        const offer = await tx.offer.findUnique({ where: { id: offerId } });
        if (!offer) {
          throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Offer not found.' });
        }
        if (offer.status !== 'ACTIVE') {
          throw DomainException.of(OFFER_INVALID_STATE, {
            message: 'Only an active offer can be changed.',
            details: { offerId, status: offer.status },
          });
        }
        if (expectedVersion !== undefined && offer.version !== expectedVersion) {
          throw DomainException.of(OFFER_VERSION_MISMATCH, {
            message: 'This offer has changed since it was last reviewed.',
            details: { offerId, actualVersion: offer.version, expectedVersion },
          });
        }
        if (offer.needsReconfirmation) {
          throw DomainException.of(OFFER_NEEDS_RECONFIRMATION, {
            message: 'This offer requires reconfirmation before negotiating again.',
            details: { offerId },
          });
        }
        if (offer.awaitingParty !== actor) {
          throw DomainException.of(OFFER_INVALID_STATE, {
            message: `It is not ${actor.toLowerCase()}\'s turn to negotiate this offer.`,
            details: { offerId, awaitingParty: offer.awaitingParty, actor },
          });
        }

        const updated = await tx.offer.update({
          where: { id: offerId },
          data: {
            amountMinor: BigInt(amountMinor),
            durationMinutes,
            message: message ?? offer.message,
            awaitingParty: actor === 'REQUESTER' ? 'RUNNER' : 'REQUESTER',
            version: { increment: 1 },
          },
        });

        await tx.negotiationEvent.create({
          data: {
            errandId: offer.errandId,
            offerId: offer.id,
            actorUserId: actor === 'REQUESTER' ? offer.requesterId : offer.runnerId,
            messageType: 'COUNTER_OFFER',
            proposedAmountMinor: BigInt(amountMinor),
            proposedDurationMinutes: durationMinutes,
            currency: 'NGN',
            message: message ?? offer.message ?? undefined,
            resultingOfferVersion: updated.version,
          },
        });

        return this.mapPersistedOffer(updated);
      });

      this.offers.set(persisted.id, persisted);
      return persisted;
    }

    const offer = this.offers.get(offerId);
    if (!offer) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Offer not found.' });
    }
    if (offer.status !== 'ACTIVE') {
      throw DomainException.of(OFFER_INVALID_STATE, {
        message: 'Only an active offer can be changed.',
        details: { offerId, status: offer.status },
      });
    }
    if (expectedVersion !== undefined && offer.version !== expectedVersion) {
      throw DomainException.of(OFFER_VERSION_MISMATCH, {
        message: 'This offer has changed since it was last reviewed.',
        details: { offerId, actualVersion: offer.version, expectedVersion },
      });
    }
    if (offer.needsReconfirmation) {
      throw DomainException.of(OFFER_NEEDS_RECONFIRMATION, {
        message: 'This offer requires reconfirmation before negotiating again.',
        details: { offerId },
      });
    }
    if (offer.awaitingParty !== actor) {
      throw DomainException.of(OFFER_INVALID_STATE, {
        message: `It is not ${actor.toLowerCase()}\'s turn to negotiate this offer.`,
        details: { offerId, awaitingParty: offer.awaitingParty, actor },
      });
    }

    offer.amountMinor = amountMinor;
    offer.durationMinutes = durationMinutes;
    offer.message = message ?? offer.message;
    offer.awaitingParty = actor === 'REQUESTER' ? 'RUNNER' : 'REQUESTER';
    offer.version += 1;
    offer.updatedAt = new Date();
    return offer;
  }

  async rejectOffer(offerId: string, actor: 'RUNNER' | 'REQUESTER', expectedVersion?: number): Promise<OfferRecord> {
    if (this.prisma) {
      const persisted = await this.prisma.$transaction(async (tx) => {
        const offer = await tx.offer.findUnique({ where: { id: offerId } });
        if (!offer) {
          throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Offer not found.' });
        }
        if (offer.status !== 'ACTIVE') {
          throw DomainException.of(OFFER_INVALID_STATE, {
            message: 'Only an active offer can be rejected.',
            details: { offerId, status: offer.status },
          });
        }
        if (expectedVersion !== undefined && offer.version !== expectedVersion) {
          throw DomainException.of(OFFER_VERSION_MISMATCH, {
            message: 'This offer has changed since it was last reviewed.',
            details: { offerId, actualVersion: offer.version, expectedVersion },
          });
        }
        if (offer.awaitingParty !== actor && offer.awaitingParty !== 'NONE') {
          throw DomainException.of(OFFER_INVALID_STATE, {
            message: `It is not ${actor.toLowerCase()}\'s turn to reject this offer.`,
            details: { offerId, awaitingParty: offer.awaitingParty, actor },
          });
        }

        const updated = await tx.offer.update({
          where: { id: offerId },
          data: {
            status: 'REJECTED',
            awaitingParty: 'NONE',
            closeReason: actor === 'REQUESTER' ? 'REQUESTER_REJECTED' : 'ADMIN_CLOSED',
            version: { increment: 1 },
          },
        });

        return this.mapPersistedOffer(updated);
      });

      this.offers.set(persisted.id, persisted);
      return persisted;
    }

    const offer = this.offers.get(offerId);
    if (!offer) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Offer not found.' });
    }
    if (offer.status !== 'ACTIVE') {
      throw DomainException.of(OFFER_INVALID_STATE, {
        message: 'Only an active offer can be rejected.',
        details: { offerId, status: offer.status },
      });
    }
    if (expectedVersion !== undefined && offer.version !== expectedVersion) {
      throw DomainException.of(OFFER_VERSION_MISMATCH, {
        message: 'This offer has changed since it was last reviewed.',
        details: { offerId, actualVersion: offer.version, expectedVersion },
      });
    }
    if (offer.awaitingParty !== actor && offer.awaitingParty !== 'NONE') {
      throw DomainException.of(OFFER_INVALID_STATE, {
        message: `It is not ${actor.toLowerCase()}\'s turn to reject this offer.`,
        details: { offerId, awaitingParty: offer.awaitingParty, actor },
      });
    }

    offer.status = 'REJECTED';
    offer.awaitingParty = 'NONE';
    offer.closeReason = actor === 'REQUESTER' ? 'REQUESTER_REJECTED' : 'ADMIN_CLOSED';
    offer.updatedAt = new Date();
    return offer;
  }

  async acceptOffer(offerId: string, expectedVersion?: number): Promise<OfferRecord> {
    if (this.prisma) {
      const persisted = await this.prisma.$transaction(async (tx) => {
        const offer = await tx.offer.findUnique({ where: { id: offerId } });
        if (!offer) {
          throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Offer not found.' });
        }
        if (offer.status !== 'ACTIVE') {
          throw DomainException.of(OFFER_INVALID_STATE, {
            message: 'Only an active offer can be accepted.',
            details: { offerId, status: offer.status },
          });
        }
        if (expectedVersion !== undefined && offer.version !== expectedVersion) {
          throw DomainException.of(OFFER_VERSION_MISMATCH, {
            message: 'This offer has changed since it was last reviewed.',
            details: { offerId, actualVersion: offer.version, expectedVersion },
          });
        }
        if (offer.needsReconfirmation) {
          throw DomainException.of(OFFER_NEEDS_RECONFIRMATION, {
            message: 'This offer needs reconfirmation before it can be selected.',
            details: { offerId },
          });
        }
        if (offer.awaitingParty !== 'REQUESTER') {
          throw DomainException.of(OFFER_INVALID_STATE, {
            message: 'The requester must act before this offer can be selected.',
            details: { offerId, awaitingParty: offer.awaitingParty },
          });
        }

        const updated = await tx.offer.update({
          where: { id: offerId },
          data: {
            status: 'SELECTED',
            awaitingParty: 'NONE',
            closeReason: 'RUNNER_SELECTED',
            selectedAt: new Date(),
            version: { increment: 1 },
          },
        });

        return this.mapPersistedOffer(updated);
      });

      this.offers.set(persisted.id, persisted);
      return persisted;
    }

    const offer = this.offers.get(offerId);
    if (!offer) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Offer not found.' });
    }
    if (offer.status !== 'ACTIVE') {
      throw DomainException.of(OFFER_INVALID_STATE, {
        message: 'Only an active offer can be accepted.',
        details: { offerId, status: offer.status },
      });
    }
    if (expectedVersion !== undefined && offer.version !== expectedVersion) {
      throw DomainException.of(OFFER_VERSION_MISMATCH, {
        message: 'This offer has changed since it was last reviewed.',
        details: { offerId, actualVersion: offer.version, expectedVersion },
      });
    }
    if (offer.needsReconfirmation) {
      throw DomainException.of(OFFER_NEEDS_RECONFIRMATION, {
        message: 'This offer needs reconfirmation before it can be selected.',
        details: { offerId },
      });
    }
    if (offer.awaitingParty !== 'REQUESTER') {
      throw DomainException.of(OFFER_INVALID_STATE, {
        message: 'The requester must act before this offer can be selected.',
        details: { offerId, awaitingParty: offer.awaitingParty },
      });
    }

    offer.status = 'SELECTED';
    offer.awaitingParty = 'NONE';
    offer.closeReason = 'RUNNER_SELECTED';
    offer.updatedAt = new Date();
    return offer;
  }

  async closeForErrand(errandId: string, reason: OfferCloseReason): Promise<number> {
    if (this.prisma) {
      const result = await this.prisma.$transaction(async (tx) => {
        const offers = await tx.offer.findMany({
          where: { errandId, status: 'ACTIVE' },
        });

        for (const offer of offers) {
          await tx.offer.update({
            where: { id: offer.id },
            data: {
              status: reason === 'ERRAND_EXPIRED' ? 'EXPIRED' : 'CLOSED',
              closeReason: reason,
              awaitingParty: 'NONE',
              closedAt: new Date(),
              version: { increment: 1 },
            },
          });
        }

        return offers.length;
      });

      for (const offer of this.offers.values()) {
        if (offer.errandId === errandId && offer.status === 'ACTIVE') {
          offer.status = reason === 'ERRAND_EXPIRED' ? 'EXPIRED' : 'CLOSED';
          offer.closeReason = reason;
          offer.awaitingParty = 'NONE';
          offer.updatedAt = new Date();
        }
      }

      return result;
    }

    let closed = 0;
    for (const offer of this.offers.values()) {
      if (offer.errandId !== errandId || offer.status !== 'ACTIVE') {
        continue;
      }
      offer.status = reason === 'ERRAND_EXPIRED' ? 'EXPIRED' : 'CLOSED';
      offer.closeReason = reason;
      offer.awaitingParty = 'NONE';
      offer.updatedAt = new Date();
      closed += 1;
    }
    return closed;
  }

  async withdraw(offerId: string, runnerId?: string): Promise<OfferRecord> {
    if (this.prisma) {
      const persisted = await this.prisma.$transaction(async (tx) => {
        const offer = await tx.offer.findUnique({ where: { id: offerId } });
        if (!offer) {
          throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Offer not found.' });
        }
        if (runnerId && offer.runnerId !== runnerId) {
          throw DomainException.of(FORBIDDEN, {
            message: 'Only the runner that submitted this offer can withdraw it.',
            details: { offerId, runnerId, ownerId: offer.runnerId },
          });
        }
        if (offer.status !== 'ACTIVE') {
          throw DomainException.of(OFFER_INVALID_STATE, { message: 'Only an active offer can be withdrawn.', details: { offerId, status: offer.status } });
        }

        const updated = await tx.offer.update({
          where: { id: offerId },
          data: {
            status: 'WITHDRAWN',
            awaitingParty: 'NONE',
            closeReason: 'RUNNER_WITHDREW',
            withdrawnAt: new Date(),
            version: { increment: 1 },
          },
        });

        return this.mapPersistedOffer(updated);
      });

      this.offers.set(persisted.id, persisted);
      return persisted;
    }

    const offer = this.offers.get(offerId);
    if (!offer) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'Offer not found.' });
    }
    if (runnerId && offer.runnerId !== runnerId) {
      throw DomainException.of(FORBIDDEN, {
        message: 'Only the runner that submitted this offer can withdraw it.',
        details: { offerId, runnerId, ownerId: offer.runnerId },
      });
    }
    if (offer.status !== 'ACTIVE') {
      throw DomainException.of(OFFER_INVALID_STATE, { message: 'Only an active offer can be withdrawn.', details: { offerId, status: offer.status } });
    }

    offer.status = 'WITHDRAWN';
    offer.awaitingParty = 'NONE';
    offer.closeReason = 'RUNNER_WITHDREW';
    offer.updatedAt = new Date();
    return offer;
  }

  private mapPersistedOffer(raw: {
    id: string;
    errandId: string;
    runnerId: string;
    requesterId: string;
    amountMinor: bigint;
    durationMinutes: number;
    status: string;
    awaitingParty: string | null;
    version: number;
    needsReconfirmation: boolean;
    closeReason?: string | null;
    conversationId?: string | null;
    createdAt: Date;
    updatedAt: Date;
    availabilityConfirmedAt?: Date | null;
    message?: string | null;
  }): OfferRecord {
    return {
      id: raw.id,
      errandId: raw.errandId,
      runnerId: raw.runnerId,
      requesterId: raw.requesterId,
      amountMinor: Number(raw.amountMinor),
      durationMinutes: raw.durationMinutes,
      status: raw.status as OfferStatus,
      awaitingParty: (raw.awaitingParty ?? 'REQUESTER') as AwaitingParty,
      version: raw.version,
      needsReconfirmation: raw.needsReconfirmation,
      closeReason: raw.closeReason as OfferCloseReason | undefined,
      conversationId: raw.conversationId ?? undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      availabilityConfirmedAt: raw.availabilityConfirmedAt ?? undefined,
      message: raw.message ?? undefined,
    };
  }

  private keyForErrandRunner(errandId: string, runnerId: string): string {
    return `${errandId}:${runnerId}`;
  }
}

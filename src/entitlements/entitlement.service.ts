import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OFFER_DAILY_LIMIT_REACHED } from '../common/constants/error-codes.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { OfferAllowance, OfferLimitStatus, OfferLimitService } from './offer-limit.service.js';

export interface EntitlementOutcome extends OfferLimitStatus {
  allowed: boolean;
  reason?: string;
}

/**
 * Centralises the free-limit / Runner Pro decision for offer submission (Backend PRD 13.6, 22.3).
 */
@Injectable()
export class EntitlementService {
  constructor(private readonly offerLimit: OfferLimitService) {}

  /** A read-only answer for display. Submitting must go through `reserveOffer`. */
  async canSubmitOffer(userId: string): Promise<EntitlementOutcome> {
    const status = await this.offerLimit.getLimitStatus(userId);
    const allowed = !status.isAtLimit;

    return {
      ...status,
      allowed,
      reason: allowed ? undefined : OFFER_DAILY_LIMIT_REACHED,
    };
  }

  async assertCanSubmitOffer(userId: string): Promise<void> {
    const entitlement = await this.canSubmitOffer(userId);
    if (!entitlement.allowed) {
      throw DomainException.of(OFFER_DAILY_LIMIT_REACHED, {
        message: "You have reached today's offer limit.",
        details: {
          used: entitlement.used,
          remaining: entitlement.remaining,
          resetsAt: entitlement.resetsAt,
        },
      });
    }
  }

  /** Check and spend one offer, atomically, inside the offer-creating transaction. */
  reserveOffer(tx: Prisma.TransactionClient, userId: string, allowance?: OfferAllowance): Promise<OfferLimitStatus> {
    return this.offerLimit.reserve(tx, userId, allowance);
  }

  /** Read before opening the transaction and pass to `reserveOffer`. */
  offerAllowance(userId: string): Promise<OfferAllowance> {
    return this.offerLimit.allowanceFor(userId);
  }
}

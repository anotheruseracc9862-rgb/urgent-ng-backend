import { Injectable } from '@nestjs/common';
import { OFFER_DAILY_LIMIT_REACHED } from '../common/constants/error-codes.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { OfferLimitStatus, OfferLimitService } from './offer-limit.service.js';

export interface EntitlementOutcome extends OfferLimitStatus {
  allowed: boolean;
  reason?: string;
}

/**
 * Centralises the free-limit / Runner Pro decision for offer submission.
 */
@Injectable()
export class EntitlementService {
  constructor(private readonly offerLimit: OfferLimitService) {}

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
}

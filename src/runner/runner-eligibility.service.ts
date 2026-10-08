import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { RestrictionService } from '../auth/restriction.service.js';
import { VerificationStatusService } from '../verification/verification-status.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { FORBIDDEN, OFFER_NOT_ELIGIBLE, VERIFICATION_PENDING, VERIFICATION_REQUIRED } from '../common/constants/error-codes.js';

export type EligibilityReason =
  | 'ACCOUNT_NOT_ACTIVE'
  | 'PHONE_NOT_VERIFIED'
  | 'NOT_VERIFIED'
  | 'VERIFICATION_PENDING'
  | 'NO_RUNNER_PROFILE'
  | 'UNAVAILABLE'
  | 'RESTRICTED';

export interface Eligibility {
  allowed: boolean;
  /** Every rule that failed, so a client can tell the runner what to do. Empty when allowed. */
  reasons: EligibilityReason[];
}

/**
 * The one place that answers "may this user browse the feed / submit an offer" (Backend PRD 10.5).
 * Other modules call it and never re-implement the checks:
 *
 *   account ACTIVE, phone verified, identity verified (valid, not expired or revoked), a runner
 *   profile that is AVAILABLE, and no active OFFERING (or all-marketplace) restriction.
 *
 * The offer allowance (daily free limit, Pro) is added by the billing tasks (PRD 13.6).
 * Verification expiry blocks new offers only: nothing here touches existing assignments.
 */
@Injectable()
export class RunnerEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly restrictions: RestrictionService,
    private readonly verification: VerificationStatusService,
  ) {}

  canOffer(userId: string): Promise<Eligibility> {
    return this.evaluate(userId);
  }

  canBrowseFeed(userId: string): Promise<Eligibility> {
    return this.evaluate(userId);
  }

  /** Throw the matching error code if the user may not offer. */
  async assertCanOffer(userId: string): Promise<void> {
    const { allowed, reasons } = await this.canOffer(userId);
    if (allowed) return;
    if (reasons.includes('NOT_VERIFIED')) throw DomainException.of(VERIFICATION_REQUIRED, { details: { reasons } });
    if (reasons.includes('VERIFICATION_PENDING')) throw DomainException.of(VERIFICATION_PENDING, { details: { reasons } });
    throw DomainException.of(OFFER_NOT_ELIGIBLE, { details: { reasons } });
  }

  /** Throw the matching error code if the user may not browse the feed. */
  async assertCanBrowseFeed(userId: string): Promise<void> {
    const { allowed, reasons } = await this.canBrowseFeed(userId);
    if (allowed) return;
    if (reasons.includes('NOT_VERIFIED')) throw DomainException.of(VERIFICATION_REQUIRED, { details: { reasons } });
    if (reasons.includes('VERIFICATION_PENDING')) throw DomainException.of(VERIFICATION_PENDING, { details: { reasons } });
    throw DomainException.of(FORBIDDEN, { message: 'You cannot browse errands right now.', details: { reasons } });
  }

  private async evaluate(userId: string): Promise<Eligibility> {
    const reasons: EligibilityReason[] = [];

    const rows = await this.prisma.$queryRaw<
      Array<{ status: string | null; phone_ok: boolean | null; availability: string | null }>
    >`
      SELECT u.status::text AS status,
             (u.phone_verified_at IS NOT NULL) AS phone_ok,
             (SELECT r.availability::text FROM runner_profiles r WHERE r.user_id = u.id AND r.deleted_at IS NULL) AS availability
      FROM users u
      WHERE u.id = ${userId}::uuid AND u.deleted_at IS NULL
    `;
    const user = rows[0];
    if (!user || user.status !== 'ACTIVE') {
      return { allowed: false, reasons: ['ACCOUNT_NOT_ACTIVE'] };
    }
    if (!user.phone_ok) reasons.push('PHONE_NOT_VERIFIED');

    if (!(await this.verification.isVerified(userId))) {
      reasons.push((await this.verification.isPending(userId)) ? 'VERIFICATION_PENDING' : 'NOT_VERIFIED');
    }

    if (user.availability === null) reasons.push('NO_RUNNER_PROFILE');
    else if (user.availability !== 'AVAILABLE') reasons.push('UNAVAILABLE');

    if (await this.restrictions.findActive(userId, 'OFFERING')) reasons.push('RESTRICTED');

    return { allowed: reasons.length === 0, reasons };
  }
}

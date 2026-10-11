import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { OfferLimitPolicy } from './offer-limit.service.js';

/**
 * Runner Pro as the offer limit sees it (Backend PRD 13.6, 22.3): a user is Pro while an
 * unrevoked RUNNER_PRO entitlement covers the database's now. Entitlement rows are written only
 * by billing, so this is the single answer to "is this runner Pro".
 *
 * Reading the clock in SQL means Pro stops the moment the paid time ends, with no job involved.
 * An offer already submitted stays valid; only future offers meet the free daily limit.
 */
@Injectable()
export class ProEntitlementPolicy implements OfferLimitPolicy {
  constructor(private readonly prisma: PrismaService) {}

  async isPro(userId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ pro: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM entitlements
        WHERE user_id = ${userId}::uuid AND type = 'RUNNER_PRO'::"EntitlementType" AND revoked_at IS NULL
          AND valid_from <= clock_timestamp() AND (valid_until IS NULL OR valid_until > clock_timestamp())
      ) AS pro
    `;
    return rows[0].pro;
  }
}

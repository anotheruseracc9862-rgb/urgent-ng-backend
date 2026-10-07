import { Injectable } from '@nestjs/common';
import type { UserRestrictionType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';

export interface ActiveRestriction {
  type: UserRestrictionType;
  endsAt: Date | null;
}

/**
 * Reads the restriction engine's output (Backend PRD 21, 9.4). A restriction is
 * active when its status is ACTIVE, it has started and it has not ended. All time
 * comparisons use the database clock.
 */
@Injectable()
export class RestrictionService {
  constructor(private readonly prisma: PrismaService) {}

  /** The active restriction of this type, or of ALL_MARKETPLACE for marketplace types. */
  async findActive(
    userId: string,
    type: UserRestrictionType,
  ): Promise<ActiveRestriction | null> {
    const applies: UserRestrictionType[] =
      type === 'ACCOUNT_LOGIN' || type === 'ALL_MARKETPLACE'
        ? [type]
        : [type, 'ALL_MARKETPLACE'];

    const rows = await this.prisma.$queryRaw<Array<{ type: UserRestrictionType; ends_at: Date | null }>>`
      SELECT type::text AS type, ends_at
      FROM user_restrictions
      WHERE user_id = ${userId}::uuid
        AND deleted_at IS NULL
        AND status = 'ACTIVE'::"RestrictionStatus"
        AND type::text = ANY(${applies as string[]}::text[])
        AND starts_at <= now()
        AND (ends_at IS NULL OR ends_at > now())
      ORDER BY ends_at DESC NULLS FIRST
      LIMIT 1
    `;

    return rows[0] ? { type: rows[0].type, endsAt: rows[0].ends_at } : null;
  }
}

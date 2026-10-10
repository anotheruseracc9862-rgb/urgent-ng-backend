import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

export type OfferSort = 'price_asc' | 'eta_asc' | 'rating_desc' | 'distance_asc';

export interface OfferListItem {
  id: string;
  runnerId: string;
  runnerName: string;
  runnerRating: number | null;
  runnerIsPro: boolean;
  amountMinor: number;
  durationMinutes: number;
  message?: string;
  awaitingParty: string;
  needsReconfirmation: boolean;
  version: number;
  createdAt: Date;
}

/**
 * Fetches offers for an errand with sorting and Pro runner priority
 * (Backend PRD 30.3, Phase 6 P6-06.3).
 */
@Injectable()
export class OfferListService {
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async getOffersForErrand(errandId: string, sort: OfferSort = 'price_asc'): Promise<OfferListItem[]> {
    if (!this.prisma) {
      return [];
    }

    // Build ORDER BY clause with Pro runners first
    const orderBy = this.buildOrderBy(sort);

    const offers = await this.prisma.$queryRaw<
      Array<{
        id: string;
        runner_id: string;
        runner_name: string;
        runner_rating: number | null;
        runner_is_pro: boolean;
        amount_minor: bigint;
        duration_minutes: number;
        message: string | null;
        awaiting_party: string;
        needs_reconfirmation: boolean;
        version: number;
        created_at: Date;
      }>
    >`
      SELECT 
        o.id::text,
        o.runner_id::text,
        u.name AS runner_name,
        rp.rating AS runner_rating,
        COALESCE(rp.is_pro, false) AS runner_is_pro,
        o.amount_minor,
        o.duration_minutes,
        o.message,
        o.awaiting_party,
        o.needs_reconfirmation,
        o.version,
        o.created_at
      FROM offers o
      INNER JOIN users u ON o.runner_id = u.id
      LEFT JOIN runner_profiles rp ON o.runner_id = rp.user_id
      WHERE o.errand_id = ${errandId}::uuid
        AND o.status = 'ACTIVE'
      ORDER BY ${orderBy}
    `;

    return offers.map((row) => ({
      id: row.id,
      runnerId: row.runner_id,
      runnerName: row.runner_name,
      runnerRating: row.runner_rating,
      runnerIsPro: row.runner_is_pro,
      amountMinor: Number(row.amount_minor),
      durationMinutes: row.duration_minutes,
      message: row.message ?? undefined,
      awaitingParty: row.awaiting_party,
      needsReconfirmation: row.needs_reconfirmation,
      version: row.version,
      createdAt: row.created_at,
    }));
  }

  private buildOrderBy(sort: OfferSort): string {
    // Pro runners always appear first (is_pro DESC gives true before false)
    const proPriority = 'COALESCE(rp.is_pro, false) DESC';

    switch (sort) {
      case 'price_asc':
        return `${proPriority}, o.amount_minor ASC`;
      case 'eta_asc':
        return `${proPriority}, o.duration_minutes ASC`;
      case 'rating_desc':
        return `${proPriority}, rp.rating DESC NULLS LAST`;
      case 'distance_asc':
        // Distance would require errand location - for now just use creation time as tie-breaker
        return `${proPriority}, o.created_at ASC`;
      default:
        return `${proPriority}, o.amount_minor ASC`;
    }
  }
}

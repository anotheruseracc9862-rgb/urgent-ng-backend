import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import { OfferLimitService } from '../entitlements/offer-limit.service.js';
import { VerificationStatusService } from '../verification/verification-status.service.js';
import { distanceBucket } from '../errands/location-privacy.js';
import type { OfferListItemDto, OfferSort } from './offer-list.dto.js';

interface Row {
  id: string;
  runner_id: string;
  runner_name: string;
  photo_media_id: string | null;
  amount_minor: bigint;
  duration_minutes: number;
  message: string | null;
  awaiting_party: string;
  needs_reconfirmation: boolean;
  version: number;
  created_at: Date;
  distance_m: number | null;
}

type Entry = { item: OfferListItemDto; distanceM: number | null };

/**
 * The requester's offer list (Backend PRD 13.7). Only the errand's owner may read it. Sorting is
 * done on the chosen key with the tie-break (Runner Pro first, then createdAt, then id): Pro
 * never overrides the sort the requester picked.
 */
@Injectable()
export class OfferListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly offerLimit: OfferLimitService,
    private readonly verification: VerificationStatusService,
  ) {}

  async getOffersForErrand(requesterId: string, errandId: string, sort: OfferSort = 'price_asc'): Promise<OfferListItemDto[]> {
    const owner = await this.prisma.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM errands
      WHERE id = ${errandId}::uuid AND requester_id = ${requesterId}::uuid AND deleted_at IS NULL
    `;
    if (owner.length === 0) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }

    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT o.id::text, o.runner_id::text, u.name AS runner_name, p.photo_media_id::text AS photo_media_id,
             o.amount_minor, o.duration_minutes, o.message, o.awaiting_party::text, o.needs_reconfirmation,
             o.version, o.created_at,
             ST_Distance(rp.area_center, e.feed_point)::float8 AS distance_m
      FROM offers o
      JOIN errands e ON e.id = o.errand_id
      JOIN users u ON u.id = o.runner_id
      LEFT JOIN profiles p ON p.user_id = o.runner_id AND p.deleted_at IS NULL
      LEFT JOIN runner_profiles rp ON rp.user_id = o.runner_id AND rp.deleted_at IS NULL
      WHERE o.errand_id = ${errandId}::uuid AND o.status = 'ACTIVE'::"OfferStatus" AND o.deleted_at IS NULL
    `;

    const entries: Array<Entry & { isPro: boolean }> = [];
    for (const row of rows) {
      const [isPro, verified] = await Promise.all([this.offerLimit.isPro(row.runner_id), this.verification.isVerified(row.runner_id)]);
      entries.push({
        isPro,
        distanceM: row.distance_m,
        item: {
          id: row.id,
          runnerId: row.runner_id,
          runnerName: row.runner_name,
          runnerPhotoMediaId: row.photo_media_id,
          runnerVerified: verified,
          runnerRating: null,
          runnerIsPro: isPro,
          amountMinor: Number(row.amount_minor),
          durationMinutes: row.duration_minutes,
          message: row.message ?? undefined,
          distanceBucket: row.distance_m === null ? null : distanceBucket(row.distance_m).label,
          awaitingParty: row.awaiting_party,
          needsReconfirmation: row.needs_reconfirmation,
          version: row.version,
          createdAt: row.created_at,
        },
      });
    }

    return entries.sort((a, b) => compare(a, b, sort)).map((entry) => entry.item);
  }
}

function primary(a: Entry, b: Entry, sort: OfferSort): number {
  switch (sort) {
    case 'eta_asc':
      return a.item.durationMinutes - b.item.durationMinutes;
    case 'rating_desc':
      // Ratings arrive in Phase 9; until then every runner is unrated and this key ties.
      return (b.item.runnerRating ?? -1) - (a.item.runnerRating ?? -1);
    case 'distance_asc':
      return (a.distanceM ?? Number.POSITIVE_INFINITY) - (b.distanceM ?? Number.POSITIVE_INFINITY) || 0;
    default:
      return a.item.amountMinor - b.item.amountMinor;
  }
}

function compare(a: Entry & { isPro: boolean }, b: Entry & { isPro: boolean }, sort: OfferSort): number {
  const chosen = primary(a, b, sort);
  if (chosen !== 0 && Number.isFinite(chosen)) return chosen;
  if (a.isPro !== b.isPro) return a.isPro ? -1 : 1;
  const byTime = a.item.createdAt.getTime() - b.item.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
}

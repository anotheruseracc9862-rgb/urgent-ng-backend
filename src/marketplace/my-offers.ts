import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service.js';
import type { FeedItemDto, MyOfferDto } from './marketplace.dto.js';

/**
 * Put the viewer's own live offer on each errand of a page, in one query for the whole page. A runner
 * has at most one offer per errand, and only an active one is shown: a withdrawn or declined offer is
 * not something to act on from a card.
 */
export async function attachMyOffers(prisma: Pick<PrismaService, '$queryRaw'>, userId: string, items: FeedItemDto[]): Promise<void> {
  if (items.length === 0) return;
  const rows = await prisma.$queryRaw<
    Array<{ errand_id: string; id: string; amount_minor: bigint; duration_minutes: number; awaiting_party: MyOfferDto['awaitingParty']; needs_reconfirmation: boolean }>
  >(Prisma.sql`
    SELECT errand_id::text, id::text, amount_minor, duration_minutes, awaiting_party::text AS awaiting_party, needs_reconfirmation
    FROM offers
    WHERE runner_id = ${userId}::uuid AND status = 'ACTIVE'::"OfferStatus" AND deleted_at IS NULL
      AND errand_id = ANY(${items.map((item) => item.id)}::uuid[])
  `);
  const byErrand = new Map(rows.map((row) => [row.errand_id, row]));
  for (const item of items) {
    const row = byErrand.get(item.id);
    item.myOffer = row
      ? { id: row.id, amountMinor: Number(row.amount_minor), durationMinutes: row.duration_minutes, awaitingParty: row.awaiting_party, needsReconfirmation: row.needs_reconfirmation }
      : null;
  }
}

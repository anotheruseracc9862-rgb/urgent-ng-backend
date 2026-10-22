import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service.js';
import type { MyOfferDto } from './marketplace.dto.js';

/**
 * Put the viewer's own offer on each errand of a page, in one query for the whole page. A runner may make
 * only one offer per errand, so the latest one is shown whatever its state: a card says "Offer sent", or
 * "Offer declined", and never offers a second offer that would be refused.
 */
export async function attachMyOffers(prisma: Pick<PrismaService, '$queryRaw'>, userId: string, items: Array<{ id: string; myOffer: MyOfferDto | null }>): Promise<void> {
  if (items.length === 0) return;
  const rows = await prisma.$queryRaw<
    Array<{ errand_id: string; id: string; status: MyOfferDto['status']; amount_minor: bigint; duration_minutes: number; awaiting_party: MyOfferDto['awaitingParty']; needs_reconfirmation: boolean }>
  >(Prisma.sql`
    SELECT DISTINCT ON (errand_id) errand_id::text, id::text, status::text AS status, amount_minor, duration_minutes,
           awaiting_party::text AS awaiting_party, needs_reconfirmation
    FROM offers
    WHERE runner_id = ${userId}::uuid AND deleted_at IS NULL
      AND errand_id = ANY(${items.map((item) => item.id)}::uuid[])
    ORDER BY errand_id, created_at DESC
  `);
  const byErrand = new Map(rows.map((row) => [row.errand_id, row]));
  for (const item of items) {
    const row = byErrand.get(item.id);
    item.myOffer = row
      ? { id: row.id, status: row.status, amountMinor: Number(row.amount_minor), durationMinutes: row.duration_minutes, awaitingParty: row.awaiting_party, needsReconfirmation: row.needs_reconfirmation }
      : null;
  }
}

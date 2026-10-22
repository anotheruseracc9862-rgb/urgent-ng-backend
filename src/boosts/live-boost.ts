import type { Prisma } from '@prisma/client';

type Client = { $queryRaw: <T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => Promise<T> };

export interface LiveBoost {
  expiresAt: Date;
  startedAt: Date;
  /** Runners who opened the errand's page since the boost started. A count only: who they are is never shown. */
  openedByCount: number;
  /** Offers the errand received since the boost started. */
  offersSinceCount: number;
}

/**
 * The boost running right now on each of these errands, by errand id, with what it has brought so far. A boost counts only
 * between its start and its end, on the database clock, so a boost that ran out and has not been swept yet is not shown.
 * One live boost per errand.
 */
export async function findLiveBoosts(client: Client, errandIds: string[]): Promise<Map<string, LiveBoost>> {
  if (errandIds.length === 0) return new Map();
  const rows = await client.$queryRaw<Array<{ errand_id: string; expires_at: Date; activates_at: Date; opened_by: number; offers_since: number }>>`
    SELECT b.errand_id::text, b.expires_at, b.activates_at,
           (SELECT count(*)::int FROM errand_views v WHERE v.errand_id = b.errand_id AND v.last_viewed_at >= b.activates_at) AS opened_by,
           (SELECT count(*)::int FROM offers o WHERE o.errand_id = b.errand_id AND o.deleted_at IS NULL AND o.created_at >= b.activates_at) AS offers_since
    FROM boosts b
    WHERE b.errand_id = ANY(${errandIds}::uuid[]) AND b.status = 'ACTIVE'::"BoostStatus"
      AND b.activates_at <= clock_timestamp() AND b.expires_at > clock_timestamp()
  `;
  return new Map(rows.map((row) => [row.errand_id, {
    expiresAt: row.expires_at,
    startedAt: row.activates_at,
    openedByCount: row.opened_by,
    offersSinceCount: row.offers_since,
  }]));
}

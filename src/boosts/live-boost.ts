import type { Prisma } from '@prisma/client';

type Client = { $queryRaw: <T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => Promise<T> };

/**
 * The boost running right now on each of these errands, by errand id. A boost counts only between its start and its end, on
 * the database clock, so a boost that ran out and has not been swept yet is not shown. One live boost per errand.
 */
export async function findLiveBoosts(client: Client, errandIds: string[]): Promise<Map<string, { expiresAt: Date }>> {
  if (errandIds.length === 0) return new Map();
  const rows = await client.$queryRaw<Array<{ errand_id: string; expires_at: Date }>>`
    SELECT errand_id::text, expires_at FROM boosts
    WHERE errand_id = ANY(${errandIds}::uuid[]) AND status = 'ACTIVE'::"BoostStatus"
      AND activates_at <= clock_timestamp() AND expires_at > clock_timestamp()
  `;
  return new Map(rows.map((row) => [row.errand_id, { expiresAt: row.expires_at }]));
}

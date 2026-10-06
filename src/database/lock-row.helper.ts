/**
 * Row locking helper using FOR UPDATE
 * Prevents concurrent modifications in transactions
 */

import { PrismaClient } from '@prisma/client';

/**
 * Lock a single row for update within a transaction
 * Uses SELECT ... FOR UPDATE to acquire an exclusive row lock
 * 
 * @param tx - Prisma transaction client
 * @param table - Table name
 * @param id - Row ID (UUID as string)
 * @param columns - Specific columns to select (defaults to * which may fail with unsupported types)
 * @returns The locked row or null if not found
 * 
 * @example
 * await prisma.$transaction(async (tx) => {
 *   const row = await lockRow(tx, 'errands', errandId, 'id, status, version');
 *   if (!row) throw new Error('Not found');
 *   // Perform updates knowing no other transaction can modify this row
 * });
 */
export async function lockRow<T = unknown>(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  table: string,
  id: string,
  columns = '*',
): Promise<T | null> {
  const result = await tx.$queryRawUnsafe<T[]>(
    `SELECT ${columns} FROM "${table}" WHERE id = $1::uuid FOR UPDATE`,
    id,
  );

  return result.length > 0 ? result[0] : null;
}

/**
 * Lock multiple rows for update within a transaction
 * 
 * @param tx - Prisma transaction client
 * @param table - Table name
 * @param ids - Array of row IDs
 * @param columns - Specific columns to select (defaults to *)
 * @returns Array of locked rows (may be fewer than requested if some don't exist)
 */
export async function lockRows<T = unknown>(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  table: string,
  ids: string[],
  columns = '*',
): Promise<T[]> {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map((_, i) => `$${i + 1}::uuid`).join(', ');
  
  return tx.$queryRawUnsafe<T[]>(
    `SELECT ${columns} FROM "${table}" WHERE id IN (${placeholders}) FOR UPDATE`,
    ...ids,
  );
}

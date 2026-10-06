import { CursorData } from './cursor.service.js';

export type SortDirection = 'asc' | 'desc';

export interface PrismaCursorOptions {
  cursor?: CursorData;
  limit: number;
  sortField: string;
  sortDirection?: SortDirection;
}

/**
 * Build Prisma where clause for cursor pagination
 * Uses OR logic: (sortField > cursor.sort) OR (sortField = cursor.sort AND createdAt > cursor.createdAt) OR (sortField = cursor.sort AND createdAt = cursor.createdAt AND id > cursor.id)
 */
export function buildPrismaWhere(options: PrismaCursorOptions): any {
  const { cursor, sortField, sortDirection = 'asc' } = options;

  if (!cursor) {
    return {};
  }

  const isAsc = sortDirection === 'asc';
  const op = isAsc ? 'gt' : 'lt';

  return {
    OR: [
      // Primary sort field comparison
      {
        [sortField]: { [op]: cursor.sort },
      },
      // Same sort value, compare createdAt
      {
        AND: [
          { [sortField]: cursor.sort },
          { createdAt: { [op]: cursor.createdAt } },
        ],
      },
      // Same sort and createdAt, compare id (tiebreaker)
      {
        AND: [
          { [sortField]: cursor.sort },
          { createdAt: cursor.createdAt },
          { id: { [op]: cursor.id } },
        ],
      },
    ],
  };
}

/**
 * Build Prisma orderBy for cursor pagination
 */
export function buildPrismaOrderBy(
  sortField: string,
  sortDirection: SortDirection = 'asc',
): any[] {
  return [
    { [sortField]: sortDirection },
    { createdAt: sortDirection },
    { id: sortDirection },
  ];
}

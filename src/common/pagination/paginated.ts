import type { CursorData, CursorService } from './cursor.service.js';

export interface PageMeta {
  hasNextPage: boolean;
  nextCursor?: string;
}

/**
 * Return a `Paginated` from a service or controller and the response
 * interceptor lifts `meta` into the envelope instead of nesting it inside
 * `data` (Backend PRD section 6.3).
 */
export class Paginated<T> {
  constructor(
    public readonly items: T[],
    public readonly meta: PageMeta,
  ) {}
}

/**
 * Build a page from `limit + 1` fetched rows. The extra row only signals that
 * another page exists; it is not returned.
 */
export function toPage<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
  cursors: CursorService,
  sortValue: (row: T) => CursorData['sort'] = (row) => row.createdAt.toISOString(),
): Paginated<T> {
  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return new Paginated(items, {
    hasNextPage,
    ...(hasNextPage && last
      ? {
          nextCursor: cursors.encode({
            sort: sortValue(last),
            createdAt: last.createdAt,
            id: last.id,
          }),
        }
      : {}),
  });
}

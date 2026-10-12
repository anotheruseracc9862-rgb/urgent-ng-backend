import { Injectable } from '@nestjs/common';
import { CursorService } from '../../common/pagination/cursor.service.js';
import { Paginated } from '../../common/pagination/paginated.js';

/** A row that can anchor a cursor: newest first by `createdAt`, then `id`. */
export interface Pageable {
  id: string;
  createdAt: Date;
}

/**
 * Cursor paging for admin lists: newest first, `(createdAt, id)` as the total order. Every admin
 * list reads `limit + 1` rows and hands them here.
 */
@Injectable()
export class AdminPager {
  constructor(private readonly cursors: CursorService) {}

  /** The `(createdAt, id)` the page starts after, or undefined for the first page. */
  after(cursor?: string): { createdAt: Date; id: string } | undefined {
    if (!cursor) return undefined;
    const decoded = this.cursors.decode(cursor);
    return { createdAt: decoded.createdAt as Date, id: decoded.id };
  }

  page<T extends Pageable, V = T>(rows: T[], limit: number, map?: (row: T) => V): Paginated<V> {
    const hasNextPage = rows.length > limit;
    const items = hasNextPage ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return new Paginated(items.map((row) => (map ? map(row) : (row as unknown as V))), {
      hasNextPage,
      ...(hasNextPage && last
        ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) }
        : {}),
    });
  }
}

/** A like pattern that treats the search text literally (no `%` or `_` wildcards from the caller). */
export function likePattern(term: string): string {
  return `%${term.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Digits of a phone search, for a prefix match on the stored E.164 value. */
export function phoneFragment(term: string): string | null {
  const digits = term.replace(/[^\d+]/g, '');
  return digits.length >= 4 ? digits : null;
}

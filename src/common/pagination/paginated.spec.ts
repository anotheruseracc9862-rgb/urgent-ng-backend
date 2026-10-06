import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { CursorService } from './cursor.service.js';
import { Paginated, toPage } from './paginated.js';

describe('toPage', () => {
  const cursors = new CursorService(
    new ConfigService({ security: { hmacSecret: 'test-secret' } }),
  );
  const row = (n: number) => ({
    id: `id-${n}`,
    createdAt: new Date(2026, 0, n),
  });

  it('returns every row and no cursor when there is no next page', () => {
    const page = toPage([row(1), row(2)], 5, cursors);

    expect(page).toBeInstanceOf(Paginated);
    expect(page.items).toHaveLength(2);
    expect(page.meta).toEqual({ hasNextPage: false });
  });

  it('drops the extra probe row and returns a decodable cursor for the last item', () => {
    const rows = [row(1), row(2), row(3)];
    const page = toPage(rows, 2, cursors);

    expect(page.items).toHaveLength(2);
    expect(page.meta.hasNextPage).toBe(true);

    const decoded = cursors.decode(page.meta.nextCursor as string);
    expect(decoded.id).toBe('id-2');
    expect(decoded.createdAt.toISOString()).toBe(rows[1].createdAt.toISOString());
  });

  it('uses a custom sort value in the cursor', () => {
    const page = toPage(
      [{ ...row(1), amount: 500 }, { ...row(2), amount: 700 }],
      1,
      cursors,
      (r) => r.amount,
    );

    expect(cursors.decode(page.meta.nextCursor as string).sort).toBe(500);
  });
});

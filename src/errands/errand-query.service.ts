import { Injectable } from '@nestjs/common';
import { Prisma, type ErrandStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { ErrandExpiryService } from './errand-expiry.service.js';
import { toNumber } from './errand-view.service.js';
import type { ErrandSummaryDto, MineSort, MineTab } from './errand.dto.js';

const TAB_STATUSES: Record<MineTab, ErrandStatus[]> = {
  DRAFT: ['DRAFT'],
  OPEN: ['OPEN'],
  ACTIVE: ['RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED', 'DISPUTED'],
  PAST: ['COMPLETED', 'CANCELLED', 'EXPIRED'],
};

/** The requester's own list of errands, for the dashboard tabs (Backend PRD 30.4). */
@Injectable()
export class ErrandQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cursors: CursorService,
    private readonly expiry: ErrandExpiryService,
  ) {}

  async mine(
    userId: string,
    options: { tab?: MineTab; sort?: MineSort; q?: string; cursor?: string; limit?: number },
  ): Promise<Paginated<ErrandSummaryDto>> {
    const limit = options.limit ?? 20;
    const sort: MineSort = options.sort ?? 'RECENT';
    // Close this requester's overdue errands first, so the OPEN tab never shows one whose time has passed.
    await this.expireOverdue(userId);

    // The sort key, the tie-break time and the id make a total order, so a cursor never skips or repeats.
    const sortKey =
      sort === 'HIGHEST_AMOUNT'
        ? Prisma.sql`COALESCE(e.suggested_budget_minor, -1)::double precision`
        : sort === 'NEEDS_ATTENTION'
          ? Prisma.sql`(CASE
              WHEN e.status = 'DELIVERED' THEN 3
              WHEN e.status = 'RUNNER_SELECTED' THEN 2
              WHEN e.status = 'OPEN' AND e.offer_count > 0 THEN 2
              WHEN e.status IN ('ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DISPUTED') THEN 1
              ELSE 0 END)::double precision`
          : Prisma.sql`0::double precision`;
    const timeColumn = sort === 'NEEDS_ATTENTION' ? Prisma.sql`e.updated_at` : Prisma.sql`e.created_at`;

    const conditions: Prisma.Sql[] = [Prisma.sql`e.requester_id = ${userId}::uuid`, Prisma.sql`e.deleted_at IS NULL`];
    if (options.tab) {
      conditions.push(Prisma.sql`e.status::text = ANY(${TAB_STATUSES[options.tab] as string[]}::text[])`);
    }
    const term = options.q?.trim();
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(Prisma.sql`(
        e.title ILIKE ${like}
        OR e.description ILIKE ${like}
        OR EXISTS (
          SELECT 1 FROM assignments a JOIN users u ON u.id = a.runner_id
          WHERE a.errand_id = e.id AND a.deleted_at IS NULL AND (u.first_name ILIKE ${like} OR u.name ILIKE ${like})
        )
      )`);
    }
    if (options.cursor) {
      const c = this.cursors.decode(options.cursor);
      conditions.push(
        Prisma.sql`(${sortKey}, ${timeColumn}, e.id) < (${Number(c.sort)}::double precision, ${c.createdAt as Date}::timestamptz, ${c.id}::uuid)`,
      );
    }

    const keys = await this.prisma.$queryRaw<Array<{ id: string; sort_key: number; ts: Date }>>`
      SELECT e.id::text AS id, ${sortKey} AS sort_key, ${timeColumn} AS ts
      FROM errands e
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY sort_key DESC, ts DESC, e.id DESC
      LIMIT ${limit + 1}
    `;
    const hasNextPage = keys.length > limit;
    const pageKeys = hasNextPage ? keys.slice(0, limit) : keys;
    const last = pageKeys[pageKeys.length - 1];

    const found = await this.prisma.client.errand.findMany({
      where: { id: { in: pageKeys.map((k) => k.id) } },
      include: { category: true, locations: { where: { deletedAt: null }, select: { type: true, area: true } } },
    });
    const byId = new Map(found.map((errand) => [errand.id, errand]));
    const page = pageKeys.map((k) => byId.get(k.id)).filter((errand): errand is NonNullable<typeof errand> => Boolean(errand));

    return new Paginated(
      page.map((errand) => ({
        id: errand.id,
        status: errand.status,
        title: errand.title,
        category: { id: errand.category.id, key: errand.category.key, name: errand.category.name },
        priority: errand.priority,
        timeMode: errand.timeMode,
        scheduledAt: errand.scheduledAt,
        suggestedBudgetMinor: toNumber(errand.suggestedBudgetMinor),
        pickupArea: errand.locations.find((l) => l.type === 'ERRAND_PICKUP')?.area ?? null,
        destinationArea: errand.locations.find((l) => l.type === 'ERRAND_DESTINATION')?.area ?? null,
        offerCount: errand.offerCount,
        publishedAt: errand.publishedAt,
        expiresAt: errand.expiresAt,
        createdAt: errand.createdAt,
        updatedAt: errand.updatedAt,
      })),
      {
        hasNextPage,
        ...(hasNextPage && last
          ? { nextCursor: this.cursors.encode({ sort: last.sort_key, createdAt: last.ts, id: last.id }) }
          : {}),
      },
    );
  }

  private async expireOverdue(userId: string): Promise<void> {
    const overdue = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM errands
      WHERE requester_id = ${userId}::uuid AND status = 'OPEN'::"ErrandStatus" AND deleted_at IS NULL
        AND expires_at <= clock_timestamp()
      LIMIT 50
    `;
    for (const { id } of overdue) {
      await this.expiry.expireIfDue(id);
    }
  }
}

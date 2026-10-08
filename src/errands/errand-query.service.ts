import { Injectable } from '@nestjs/common';
import type { ErrandStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { ErrandExpiryService } from './errand-expiry.service.js';
import { toNumber } from './errand-view.service.js';
import type { ErrandSummaryDto, MineTab } from './errand.dto.js';

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

  async mine(userId: string, options: { tab?: MineTab; cursor?: string; limit?: number }): Promise<Paginated<ErrandSummaryDto>> {
    const limit = options.limit ?? 20;
    // Close this requester's overdue errands first, so the OPEN tab never shows one whose time has passed.
    await this.expireOverdue(userId);

    const cursor = options.cursor ? this.cursors.decode(options.cursor) : undefined;
    const where: Prisma.ErrandWhereInput = {
      requesterId: userId,
      ...(options.tab ? { status: { in: TAB_STATUSES[options.tab] } } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt as Date } },
              { createdAt: cursor.createdAt as Date, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.client.errand.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { category: true, locations: { where: { deletedAt: null }, select: { type: true, area: true } } },
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

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
        ...(hasNextPage && last ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) } : {}),
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

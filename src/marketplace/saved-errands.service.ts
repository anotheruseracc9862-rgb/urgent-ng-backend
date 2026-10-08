import { Injectable } from '@nestjs/common';
import { Prisma, type ErrandStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import { RunnerEligibilityService } from '../runner/runner-eligibility.service.js';
import { FEED_COLUMNS, FEED_JOINS, openErrandVisibleTo, toFeedItem, type FeedRow } from './marketplace-feed.service.js';
import type { SavedErrandItemDto } from './marketplace.dto.js';

interface SavedRow extends FeedRow {
  status: ErrandStatus;
  saved_id: string;
  saved_at: Date;
}

/** A runner's saved errands (Backend PRD 11.8). Saving and removing are repeatable without harm. */
@Injectable()
export class SavedErrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cursors: CursorService,
    private readonly eligibility: RunnerEligibilityService,
  ) {}

  /** Only an errand the runner could see in the feed can be saved. Saving twice keeps one row. */
  async save(userId: string, errandId: string): Promise<{ saved: true }> {
    await this.eligibility.assertCanBrowseFeed(userId);
    const visible = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT e.id::text FROM errands e WHERE e.id = ${errandId}::uuid AND ${openErrandVisibleTo(userId)}
    `);
    if (visible.length === 0) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    await this.prisma.$executeRaw`
      INSERT INTO saved_errands (user_id, errand_id)
      VALUES (${userId}::uuid, ${errandId}::uuid)
      ON CONFLICT (user_id, errand_id) WHERE deleted_at IS NULL DO NOTHING
    `;
    return { saved: true };
  }

  async remove(userId: string, errandId: string): Promise<{ saved: false }> {
    await this.prisma.$executeRaw`
      UPDATE saved_errands SET deleted_at = now()
      WHERE user_id = ${userId}::uuid AND errand_id = ${errandId}::uuid AND deleted_at IS NULL
    `;
    return { saved: false };
  }

  /** Newest save first. Includes errands that have since closed, with their status. */
  async list(userId: string, options: { cursor?: string; limit?: number }): Promise<Paginated<SavedErrandItemDto>> {
    const limit = options.limit ?? 20;
    const cursor = options.cursor ? this.cursors.decode(options.cursor) : undefined;
    const keyset = cursor
      ? Prisma.sql`AND (s.created_at, s.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<SavedRow[]>(Prisma.sql`
      SELECT ${FEED_COLUMNS}, e.status::text AS status, s.id::text AS saved_id, s.created_at AS saved_at,
             CASE WHEN me.area_center IS NULL OR e.feed_point IS NULL THEN NULL
                  ELSE round(ST_Distance(e.feed_point, me.area_center))::int END AS dist_m,
             true AS saved
      FROM saved_errands s
      JOIN errands e ON e.id = s.errand_id AND e.deleted_at IS NULL
      LEFT JOIN runner_profiles me ON me.user_id = ${userId}::uuid AND me.deleted_at IS NULL
      ${FEED_JOINS}
      WHERE s.user_id = ${userId}::uuid AND s.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE b.deleted_at IS NULL
            AND ((b.blocker_id = ${userId}::uuid AND b.blocked_id = e.requester_id)
              OR (b.blocker_id = e.requester_id AND b.blocked_id = ${userId}::uuid))
        )
        ${keyset}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ${limit + 1}
    `);
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return new Paginated(
      page.map((row) => ({ ...toFeedItem(row), status: row.status, savedAt: row.saved_at })),
      {
        hasNextPage,
        ...(hasNextPage && last
          ? { nextCursor: this.cursors.encode({ sort: last.saved_at.toISOString(), createdAt: last.saved_at, id: last.saved_id }) }
          : {}),
      },
    );
  }
}

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';

/** What a profile, an offer or a feed row shows about one user's record (Backend PRD 20.4). */
export interface UserStatsView {
  completedAsRunner: number;
  completedAsRequester: number;
  /** Published, revealed ratings of the user as a runner. `average` is null below the minimum count. */
  runner: { count: number; average: number | null };
  requester: { count: number; average: number | null };
  paymentConduct: { count: number; average: number | null };
}

const EMPTY: UserStatsView = {
  completedAsRunner: 0,
  completedAsRequester: 0,
  runner: { count: 0, average: null },
  requester: { count: 0, average: null },
  paymentConduct: { count: 0, average: null },
};

type Executor = Pick<Prisma.TransactionClient, '$executeRaw'>;

/**
 * Derived per-user aggregates (`user_stats`). Everything is computed from source rows and is
 * rebuildable: `recompute` is idempotent and is the only writer. Only published and revealed
 * ratings count (Backend PRD 20.4), so a hidden or removed rating, or one still under blind
 * reveal, is in no figure.
 */
@Injectable()
export class UserStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
  ) {}

  /** Rebuild one user's row inside the caller's transaction (or on the plain client). */
  async recompute(client: Executor, userId: string): Promise<void> {
    await client.$executeRaw`
      INSERT INTO user_stats (
        user_id, completed_as_runner, completed_as_requester,
        runner_rating_count, runner_rating_avg, requester_rating_count, requester_rating_avg,
        payment_conduct_count, payment_conduct_avg, updated_at
      )
      SELECT
        ${userId}::uuid,
        (SELECT count(*)::int FROM assignments a
          WHERE a.runner_id = ${userId}::uuid AND a.status = 'COMPLETED'::"AssignmentStatus" AND a.deleted_at IS NULL),
        (SELECT count(*)::int FROM assignments a
          WHERE a.requester_id = ${userId}::uuid AND a.status = 'COMPLETED'::"AssignmentStatus" AND a.deleted_at IS NULL),
        r.runner_count, r.runner_avg, r.requester_count, r.requester_avg,
        p.conduct_count, p.conduct_avg,
        clock_timestamp()
      FROM (
        SELECT
          count(*) FILTER (WHERE rt.direction = 'REQUESTER_TO_RUNNER')::int AS runner_count,
          round(avg(s.score) FILTER (WHERE rt.direction = 'REQUESTER_TO_RUNNER'), 2) AS runner_avg,
          count(*) FILTER (WHERE rt.direction = 'RUNNER_TO_REQUESTER')::int AS requester_count,
          round(avg(s.score) FILTER (WHERE rt.direction = 'RUNNER_TO_REQUESTER'), 2) AS requester_avg
        FROM ratings rt
        JOIN rating_scores s ON s.rating_id = rt.id AND s.dimension = 'OVERALL'::"RatingDimension"
        WHERE rt.ratee_id = ${userId}::uuid AND rt.status = 'PUBLISHED'::"RatingStatus"
          AND rt.revealed_at IS NOT NULL AND rt.deleted_at IS NULL
      ) r,
      (
        SELECT count(*)::int AS conduct_count, round(avg(s.score), 2) AS conduct_avg
        FROM ratings rt
        JOIN rating_scores s ON s.rating_id = rt.id AND s.dimension = 'PAYMENT_CONDUCT'::"RatingDimension"
        WHERE rt.ratee_id = ${userId}::uuid AND rt.direction = 'RUNNER_TO_REQUESTER'
          AND rt.status = 'PUBLISHED'::"RatingStatus" AND rt.revealed_at IS NOT NULL AND rt.deleted_at IS NULL
      ) p
      ON CONFLICT (user_id) DO UPDATE SET
        completed_as_runner = EXCLUDED.completed_as_runner,
        completed_as_requester = EXCLUDED.completed_as_requester,
        runner_rating_count = EXCLUDED.runner_rating_count,
        runner_rating_avg = EXCLUDED.runner_rating_avg,
        requester_rating_count = EXCLUDED.requester_rating_count,
        requester_rating_avg = EXCLUDED.requester_rating_avg,
        payment_conduct_count = EXCLUDED.payment_conduct_count,
        payment_conduct_avg = EXCLUDED.payment_conduct_avg,
        updated_at = clock_timestamp()
    `;
  }

  async get(userId: string): Promise<UserStatsView> {
    return (await this.getMany([userId])).get(userId) ?? EMPTY;
  }

  /** The public view for several users at once. A user with no row has an empty record. */
  async getMany(userIds: string[]): Promise<Map<string, UserStatsView>> {
    const result = new Map<string, UserStatsView>();
    if (userIds.length === 0) return result;
    const [rows, minCount] = await Promise.all([
      this.prisma.userStats.findMany({ where: { userId: { in: userIds } } }),
      this.config.get('RATING_MIN_COUNT_FOR_AVERAGE'),
    ]);
    const shown = (count: number, average: { toString(): string } | null) => ({
      count,
      average: average !== null && count >= minCount ? Number(average.toString()) : null,
    });
    for (const row of rows) {
      result.set(row.userId, {
        completedAsRunner: row.completedAsRunner,
        completedAsRequester: row.completedAsRequester,
        runner: shown(row.runnerRatingCount, row.runnerRatingAvg),
        requester: shown(row.requesterRatingCount, row.requesterRatingAvg),
        paymentConduct: shown(row.paymentConductCount, row.paymentConductAvg),
      });
    }
    for (const id of userIds) {
      if (!result.has(id)) result.set(id, EMPTY);
    }
    return result;
  }
}

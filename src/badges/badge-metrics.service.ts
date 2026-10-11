import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { OfferLimitService } from '../entitlements/offer-limit.service.js';
import { medianMinutes, type BadgeMetrics } from './badge.rules.js';

export interface ResponseStats {
  medianMinutes: number | null;
  samples: number;
}

/**
 * Reads the figures the badge rules and the runner performance view need, always from source rows
 * (Backend PRD 21.5): windows such as "the last N accepted errands" are applied here at read
 * time, never stored, so changing one is a configuration change.
 */
@Injectable()
export class BadgeMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly offerLimit: OfferLimitService,
  ) {}

  async metrics(userId: string): Promise<BadgeMetrics> {
    const [minAmount, cancelWindow, responseWindow, reliabilityDays, highPoints] = await Promise.all([
      this.config.get('BADGE_MIN_AGREED_AMOUNT'),
      this.config.get('TRUSTED_CANCELLATION_WINDOW'),
      this.config.get('FAST_RESPONDER_WINDOW'),
      this.config.get('RELIABILITY_WINDOW_DAYS'),
      this.config.get('RELIABILITY_POINTS_HIGH'),
    ]);

    const [runnerProfile, runnerCounts, raters, cancellation, highSeverity, restriction, response, isPro, requester, conduct, nonPayment] =
      await Promise.all([
        this.prisma.runnerProfile.findFirst({ where: { userId, deletedAt: null }, select: { userId: true } }),
        this.prisma.$queryRaw<Array<{ completed: number; qualifying: number }>>`
          SELECT count(*) FILTER (WHERE status = 'COMPLETED'::"AssignmentStatus")::int AS completed,
                 count(*) FILTER (WHERE status = 'COMPLETED'::"AssignmentStatus" AND agreed_amount_minor >= ${minAmount})::int AS qualifying
          FROM assignments WHERE runner_id = ${userId}::uuid AND deleted_at IS NULL
        `,
        this.prisma.$queryRaw<Array<{ avg: number }>>`
          SELECT avg(s.score)::float8 AS avg
          FROM ratings r
          JOIN assignments a ON a.id = r.assignment_id
          JOIN rating_scores s ON s.rating_id = r.id AND s.dimension = 'OVERALL'::"RatingDimension"
          WHERE r.ratee_id = ${userId}::uuid AND r.direction = 'REQUESTER_TO_RUNNER'
            AND r.status = 'PUBLISHED'::"RatingStatus" AND r.revealed_at IS NOT NULL AND r.deleted_at IS NULL
            AND a.agreed_amount_minor >= ${minAmount}
          GROUP BY r.rater_id
        `,
        this.cancellationRate(userId, cancelWindow),
        this.prisma.$queryRaw<Array<{ one: number }>>`
          SELECT 1 AS one FROM reliability_events
          WHERE user_id = ${userId}::uuid AND severity >= ${highPoints}
            AND occurred_at > clock_timestamp() - make_interval(days => ${reliabilityDays}::int)
          LIMIT 1
        `,
        this.prisma.$queryRaw<Array<{ one: number }>>`
          SELECT 1 AS one FROM user_restrictions
          WHERE user_id = ${userId}::uuid AND status = 'ACTIVE'::"RestrictionStatus" AND deleted_at IS NULL
            AND starts_at <= clock_timestamp() AND (ends_at IS NULL OR ends_at > clock_timestamp())
          UNION ALL
          SELECT 1 FROM enforcement_actions
          WHERE user_id = ${userId}::uuid AND status = 'ACTIVE'::"RestrictionStatus"
            AND type IN ('TEMPORARY_SUSPENSION'::"EnforcementActionType", 'PERMANENT_SUSPENSION'::"EnforcementActionType")
          LIMIT 1
        `,
        this.responseStats(userId, responseWindow),
        this.offerLimit.isPro(userId),
        this.prisma.$queryRaw<Array<{ posted: number; completed: number; qualifying: number }>>`
          SELECT (SELECT count(*)::int FROM errands WHERE requester_id = ${userId}::uuid AND deleted_at IS NULL AND status <> 'DRAFT'::"ErrandStatus") AS posted,
                 count(*) FILTER (WHERE a.status = 'COMPLETED'::"AssignmentStatus")::int AS completed,
                 count(*) FILTER (WHERE a.status = 'COMPLETED'::"AssignmentStatus" AND a.agreed_amount_minor >= ${minAmount})::int AS qualifying
          FROM assignments a WHERE a.requester_id = ${userId}::uuid AND a.deleted_at IS NULL
        `,
        this.prisma.$queryRaw<Array<{ n: number; avg: number | null }>>`
          SELECT count(*)::int AS n, avg(s.score)::float8 AS avg
          FROM ratings r
          JOIN assignments a ON a.id = r.assignment_id
          JOIN rating_scores s ON s.rating_id = r.id AND s.dimension = 'PAYMENT_CONDUCT'::"RatingDimension"
          WHERE r.ratee_id = ${userId}::uuid AND r.direction = 'RUNNER_TO_REQUESTER'
            AND r.status = 'PUBLISHED'::"RatingStatus" AND r.revealed_at IS NOT NULL AND r.deleted_at IS NULL
            AND a.agreed_amount_minor >= ${minAmount}
        `,
        this.prisma.$queryRaw<Array<{ one: number }>>`
          SELECT 1 AS one FROM reports
          WHERE target_user_id = ${userId}::uuid AND type = 'NON_PAYMENT'::"ReportType" AND outcome = 'UPHELD' AND deleted_at IS NULL
            AND resolved_at > clock_timestamp() - make_interval(days => ${reliabilityDays}::int)
          LIMIT 1
        `,
      ]);

    const ratingAverage = raters.length === 0 ? null : raters.reduce((sum, r) => sum + r.avg, 0) / raters.length;
    return {
      isRunner: runnerProfile !== null,
      runnerCompleted: runnerCounts[0]?.completed ?? 0,
      runnerQualifyingCompleted: runnerCounts[0]?.qualifying ?? 0,
      distinctRaters: raters.length,
      ratingAverage,
      cancellationPercent: cancellation.percent,
      hasRecentHighSeverity: highSeverity.length > 0,
      hasActiveRestriction: restriction.length > 0,
      medianResponseMinutes: response.medianMinutes,
      responseSamples: response.samples,
      isPro,
      hasPostedErrand: (requester[0]?.posted ?? 0) > 0,
      requesterCompleted: requester[0]?.completed ?? 0,
      requesterQualifyingCompleted: requester[0]?.qualifying ?? 0,
      paymentConductCount: conduct[0]?.n ?? 0,
      paymentConductAverage: conduct[0]?.avg ?? null,
      hasUpheldNonPaymentRecently: nonPayment.length > 0,
    };
  }

  /**
   * The share of the runner's last `window` accepted assignments (ordered by acceptance, newest
   * first) that the runner themselves cancelled.
   */
  async cancellationRate(userId: string, window: number): Promise<{ percent: number | null; sample: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ n: number; cancelled: number }>>`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE status = 'CANCELLED'::"AssignmentStatus" AND cancelled_by = runner_id)::int AS cancelled
      FROM (
        SELECT status, cancelled_by, runner_id FROM assignments
        WHERE runner_id = ${userId}::uuid AND accepted_at IS NOT NULL AND deleted_at IS NULL
        ORDER BY accepted_at DESC
        LIMIT ${window}
      ) recent
    `;
    const row = rows[0];
    if (!row || row.n === 0) return { percent: null, sample: 0 };
    return { percent: (row.cancelled / row.n) * 100, sample: row.n };
  }

  /**
   * Median time to a runner's first reply, over their last `window` conversations. A reply is
   * the runner's next message or negotiation step after the requester first wrote or countered.
   * A conversation the requester wrote in and the runner never answered counts as slower than
   * any answer; one the requester never wrote in is not measured.
   */
  async responseStats(userId: string, window: number): Promise<ResponseStats> {
    const rows = await this.prisma.$queryRaw<Array<{ reply_seconds: number | null }>>`
      WITH convs AS (
        SELECT id, requester_id, offer_id FROM conversations
        WHERE runner_id = ${userId}::uuid AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ${window}
      ),
      first_ask AS (
        SELECT conv_id, min(t) AS t FROM (
          SELECT c.id AS conv_id, m.created_at AS t
          FROM convs c JOIN messages m ON m.conversation_id = c.id AND m.sender_id = c.requester_id
            AND m.type <> 'SYSTEM'::"MessageType" AND m.deleted_at IS NULL
          UNION ALL
          SELECT c.id, ne.created_at
          FROM convs c JOIN negotiation_events ne ON ne.offer_id = c.offer_id AND ne.actor_user_id = c.requester_id
            AND ne.message_type = 'COUNTER_OFFER'::"NegotiationMessageType"
        ) asks GROUP BY conv_id
      ),
      replies AS (
        SELECT c.id AS conv_id, m.created_at AS t
        FROM convs c JOIN messages m ON m.conversation_id = c.id AND m.sender_id = ${userId}::uuid
          AND m.type <> 'SYSTEM'::"MessageType" AND m.deleted_at IS NULL
        UNION ALL
        SELECT c.id, ne.created_at
        FROM convs c JOIN negotiation_events ne ON ne.offer_id = c.offer_id AND ne.actor_user_id = ${userId}::uuid
          AND ne.message_type <> 'SYSTEM_EVENT'::"NegotiationMessageType"
      )
      SELECT extract(epoch FROM (
               (SELECT min(r.t) FROM replies r WHERE r.conv_id = f.conv_id AND r.t > f.t) - f.t
             ))::float8 AS reply_seconds
      FROM first_ask f
    `;
    const minutes = rows.map((r) => (r.reply_seconds === null ? null : r.reply_seconds / 60));
    return { medianMinutes: medianMinutes(minutes), samples: minutes.length };
  }
}

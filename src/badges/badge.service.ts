import { Injectable } from '@nestjs/common';
import { AuditActorType, type BadgeType, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { VerificationStatusService } from '../verification/verification-status.service.js';
import { BadgeMetricsService } from './badge-metrics.service.js';
import {
  ALL_BADGES,
  RUNNER_BADGES,
  evaluateBadges,
  sortForDisplay,
  type BadgeMetrics,
  type BadgeName,
  type BadgeThresholds,
} from './badge.rules.js';

export interface RecomputeResult {
  awarded: BadgeName[];
  revoked: BadgeName[];
}

/**
 * Earned badges (Backend PRD 21.5). `user_badges` is a cache: `recompute` derives the badges a
 * user should hold from source rows and writes only the difference, so it can run on any trigger
 * and as a nightly pass without ever double-awarding. A badge never gates the feed or offering and
 * never affects ranking; it is display only.
 */
@Injectable()
export class BadgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: BusinessConfigService,
    private readonly metrics: BadgeMetricsService,
    private readonly verification: VerificationStatusService,
  ) {}

  async thresholds(): Promise<BadgeThresholds> {
    const [
      newBelowCompleted,
      trustedMinCompleted,
      trustedMinRatings,
      ratingEarn,
      ratingKeep,
      trustedMaxCancellationPercent,
      fastResponderMaxMinutes,
      fastResponderMinSamples,
      newRequesterBelowCompleted,
      promptPayerMinCompleted,
      promptPayerMinRatings,
    ] = await Promise.all([
      this.config.get('BADGE_NEW_BELOW_COMPLETED'),
      this.config.get('BADGE_TRUSTED_MIN_COMPLETED'),
      this.config.get('BADGE_TRUSTED_MIN_RATINGS'),
      this.config.get('BADGE_RATING_EARN'),
      this.config.get('BADGE_RATING_KEEP'),
      this.config.get('BADGE_TRUSTED_MAX_CANCELLATION_PERCENT'),
      this.config.get('BADGE_FAST_RESPONDER_MAX_MINUTES'),
      this.config.get('BADGE_FAST_RESPONDER_MIN_SAMPLES'),
      this.config.get('BADGE_NEW_REQUESTER_BELOW_COMPLETED'),
      this.config.get('BADGE_PROMPT_PAYER_MIN_COMPLETED'),
      this.config.get('BADGE_PROMPT_PAYER_MIN_RATINGS'),
    ]);
    return {
      newBelowCompleted,
      trustedMinCompleted,
      trustedMinRatings,
      ratingEarn,
      ratingKeep,
      trustedMaxCancellationPercent,
      fastResponderMaxMinutes,
      fastResponderMinSamples,
      newRequesterBelowCompleted,
      promptPayerMinCompleted,
      promptPayerMinRatings,
    };
  }

  /** Bring a user's badges in line with the rules. Idempotent; safe under concurrent calls. */
  async recompute(userId: string): Promise<RecomputeResult> {
    // Reads that need pool connections happen before the transaction.
    const [thresholds, metrics] = await Promise.all([this.thresholds(), this.metrics.metrics(userId)]);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`badges:${userId}`}))`;
      const [live, removals] = await Promise.all([
        tx.userBadge.findMany({ where: { userId, revokedAt: null } }),
        tx.enforcementAction.findMany({
          where: { userId, type: 'BADGE_REMOVAL', status: 'ACTIVE', targetBadge: { not: null } },
          select: { targetBadge: true },
        }),
      ]);
      const held = new Set<BadgeName>(live.map((b) => b.badge));
      const removed = new Set<BadgeName>(removals.map((r) => r.targetBadge as BadgeName));
      const desired = evaluateBadges(metrics, thresholds, held, removed);

      const result: RecomputeResult = { awarded: [], revoked: [] };
      for (const badge of ALL_BADGES) {
        if (desired.has(badge) && !held.has(badge)) {
          // The database clock stamps both ends of a badge, so a revoke is never "before" its award.
          await tx.$executeRaw`
            INSERT INTO user_badges (user_id, badge, awarded_at, reason_snapshot)
            VALUES (${userId}::uuid, ${badge}::"BadgeType", clock_timestamp(), ${JSON.stringify(this.snapshot(badge, metrics))}::jsonb)
          `;
          result.awarded.push(badge);
          await this.emit(tx, 'badge.awarded', userId, badge);
        } else if (!desired.has(badge) && held.has(badge)) {
          const reason = removed.has(badge) ? 'REMOVED_BY_ENFORCEMENT' : 'RULE_NO_LONGER_MET';
          await tx.$executeRaw`
            UPDATE user_badges SET revoked_at = clock_timestamp(), revoked_reason = ${reason}
            WHERE user_id = ${userId}::uuid AND badge = ${badge}::"BadgeType" AND revoked_at IS NULL
          `;
          result.revoked.push(badge);
          await this.emit(tx, 'badge.revoked', userId, badge, reason);
        }
      }

      await tx.$executeRaw`
        INSERT INTO user_stats (user_id, badges_computed_at, updated_at)
        VALUES (${userId}::uuid, clock_timestamp(), clock_timestamp())
        ON CONFLICT (user_id) DO UPDATE SET badges_computed_at = clock_timestamp()
      `;
      return result;
    });
  }

  /**
   * The badges to show beside each user, strongest first. Runner badges are hidden while the
   * runner's verification is revoked or expired (Backend PRD 21.5), and come back with it.
   */
  async visibleFor(userIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (userIds.length === 0) return out;
    const rows = await this.prisma.userBadge.findMany({
      where: { userId: { in: userIds }, revokedAt: null },
      select: { userId: true, badge: true },
    });
    const byUser = new Map<string, BadgeType[]>();
    for (const row of rows) {
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.badge]);
    }
    for (const [userId, badges] of byUser) {
      const hasRunnerBadge = badges.some((b) => (RUNNER_BADGES as readonly string[]).includes(b));
      const verified = hasRunnerBadge ? await this.verification.isVerified(userId) : true;
      const shown = badges.filter((b) => verified || !(RUNNER_BADGES as readonly string[]).includes(b));
      out.set(userId, sortForDisplay(shown));
    }
    for (const id of userIds) {
      if (!out.has(id)) out.set(id, []);
    }
    return out;
  }

  /** The figures a runner sees about their own record (Backend PRD 30.2). Windows come from config. */
  async performance(userId: string) {
    const [cancelWindow, responseWindow] = await Promise.all([this.config.get('TRUSTED_CANCELLATION_WINDOW'), this.config.get('RESPONSE_TIME_WINDOW')]);
    const [cancellation, response, stats, badges] = await Promise.all([
      this.metrics.cancellationRate(userId, cancelWindow),
      this.metrics.responseStats(userId, responseWindow),
      this.prisma.userStats.findUnique({ where: { userId } }),
      this.visibleFor([userId]),
    ]);
    const minCount = await this.config.get('RATING_MIN_COUNT_FOR_AVERAGE');
    const count = stats?.runnerRatingCount ?? 0;
    return {
      completedErrands: stats?.completedAsRunner ?? 0,
      rating: { count, average: stats?.runnerRatingAvg !== null && stats?.runnerRatingAvg !== undefined && count >= minCount ? Number(stats.runnerRatingAvg.toString()) : null },
      cancellation: { windowSize: cancelWindow, sample: cancellation.sample, percent: cancellation.percent },
      response: { windowSize: responseWindow, sample: response.samples, medianMinutes: response.medianMinutes },
      badges: badges.get(userId) ?? [],
    };
  }

  /** Users whose badges were not recomputed in the last 24 hours, oldest first (the nightly pass). */
  async dueForRecompute(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT u.id::text
      FROM users u
      LEFT JOIN user_stats s ON s.user_id = u.id
      WHERE u.deleted_at IS NULL AND u.status IN ('ACTIVE'::"UserStatus", 'SUSPENDED'::"UserStatus", 'DEACTIVATED'::"UserStatus")
        AND (s.badges_computed_at IS NULL OR s.badges_computed_at < clock_timestamp() - interval '24 hours')
        AND (
          EXISTS (SELECT 1 FROM runner_profiles rp WHERE rp.user_id = u.id AND rp.deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id = u.id AND b.revoked_at IS NULL)
          OR EXISTS (SELECT 1 FROM assignments a WHERE a.requester_id = u.id AND a.deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM errands e WHERE e.requester_id = u.id AND e.deleted_at IS NULL AND e.status <> 'DRAFT'::"ErrandStatus")
        )
      ORDER BY s.badges_computed_at NULLS FIRST, u.id
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  }

  private snapshot(badge: BadgeName, m: BadgeMetrics): object {
    const common = { computedAt: new Date().toISOString() };
    switch (badge) {
      case 'NEW':
        return { ...common, completed: m.runnerCompleted };
      case 'TRUSTED':
        return {
          ...common,
          qualifyingCompleted: m.runnerQualifyingCompleted,
          distinctRaters: m.distinctRaters,
          ratingAverage: m.ratingAverage,
          cancellationPercent: m.cancellationPercent,
        };
      case 'FAST_RESPONDER':
        return { ...common, medianResponseMinutes: m.medianResponseMinutes, samples: m.responseSamples };
      case 'PRO':
        return { ...common, activeSubscription: true };
      case 'NEW_REQUESTER':
        return { ...common, completed: m.requesterCompleted };
      case 'PROMPT_PAYER':
        return {
          ...common,
          qualifyingCompleted: m.requesterQualifyingCompleted,
          paymentConductCount: m.paymentConductCount,
          paymentConductAverage: m.paymentConductAverage,
        };
    }
  }

  private async emit(
    tx: Prisma.TransactionClient,
    eventType: 'badge.awarded' | 'badge.revoked',
    userId: string,
    badge: BadgeName,
    reason?: string,
  ): Promise<void> {
    await this.outbox.add(tx, {
      eventType,
      aggregateType: 'user',
      aggregateId: userId,
      payload: { userId, badge, ...(reason ? { reason } : {}) },
    });
    await this.audit.recordInTransaction(tx, {
      actorType: AuditActorType.SYSTEM,
      action: eventType,
      entityType: 'user',
      entityId: userId,
      reasonCode: reason,
      metadata: { badge },
    });
  }
}

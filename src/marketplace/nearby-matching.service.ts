import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { OfferLimitService } from '../entitlements/offer-limit.service.js';
import { DelayedJobHelper } from '../queue/delayed-job.helper.js';
import { NotificationService } from '../notifications/notification.service.js';
import { errandGeographySql, runnerCoverageSql } from '../geography/geography.service.js';

/** The rules of PRD 12.5, over aliases e (errand), rp (runner profile) and u (user). */
const ELIGIBLE = Prisma.sql`
      u.status = 'ACTIVE'::"UserStatus" AND u.deleted_at IS NULL AND u.phone_verified_at IS NOT NULL
      AND u.id <> e.requester_id
      AND rp.availability = 'AVAILABLE'::"RunnerAvailability"
      AND ${runnerCoverageSql('rp')}
      AND NOT (e.category_id = ANY(rp.excluded_category_ids))
      AND EXISTS (
        SELECT 1 FROM verification_attempts v
        WHERE v.user_id = u.id AND v.status = 'VERIFIED'::"VerificationStatus" AND v.deleted_at IS NULL
          AND (v.expires_at IS NULL OR v.expires_at > now())
      )
      AND NOT EXISTS (
        SELECT 1 FROM user_restrictions r
        WHERE r.user_id = u.id AND r.status = 'ACTIVE'::"RestrictionStatus" AND r.deleted_at IS NULL
          AND r.type IN ('OFFERING'::"UserRestrictionType", 'ALL_MARKETPLACE'::"UserRestrictionType")
          AND r.starts_at <= now() AND (r.ends_at IS NULL OR r.ends_at > now())
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE b.deleted_at IS NULL
          AND ((b.blocker_id = u.id AND b.blocked_id = e.requester_id) OR (b.blocker_id = e.requester_id AND b.blocked_id = u.id))
      )`;

export interface NearbyResult {
  /** Runners in the wave. */
  matched: number;
  /** Notified at once (Runner Pro). */
  immediate: number;
  /** Scheduled for the head-start delay. */
  delayed: number;
}

/**
 * Nearby-errand matching (Backend PRD 12.5). When an errand is published, the runners who could
 * take it are told: verified, available, not restricted for offering, the errand's approximate
 * point inside their operating circle, the category not excluded, and no block in either
 * direction. The first wave is the nearest `NEARBY_FIRST_WAVE_SIZE` runners. Runner Pro runners are
 * told at once and the others after `PRO_NOTIFICATION_HEAD_START_MINUTES`.
 *
 * Quiet hours and the per-runner hourly push cap are applied by the notification engine; the
 * in-app notification is always created. The deduplication key `errand:{id}:nearby:{runnerId}`
 * makes a retried event harmless.
 */
@Injectable()
export class NearbyMatchingService {
  private readonly logger = new Logger(NearbyMatchingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly offerLimit: OfferLimitService,
    private readonly delayed: DelayedJobHelper,
    private readonly notifications: NotificationService,
  ) {}

  /** The first wave for a freshly published errand. */
  async onPublished(errandId: string, occurredAt: Date): Promise<NearbyResult> {
    const [waveSize, headStartMinutes] = await Promise.all([
      this.config.get('NEARBY_FIRST_WAVE_SIZE'),
      this.config.get('PRO_NOTIFICATION_HEAD_START_MINUTES'),
    ]);
    const runners = await this.eligibleRunners(errandId, waveSize);
    if (runners.length === 0) {
      return { matched: 0, immediate: 0, delayed: 0 };
    }

    const immediate: string[] = [];
    const later: string[] = [];
    for (const runnerId of runners) {
      (await this.offerLimit.isPro(runnerId) ? immediate : later).push(runnerId);
    }

    for (const runnerId of immediate) {
      await this.notify(errandId, runnerId, occurredAt);
    }
    if (later.length > 0) {
      await this.delayed.schedule(
        'errand.nearby_delayed',
        { errandId, runnerIds: later },
        headStartMinutes * 60_000,
        'errand',
        errandId,
      );
    }
    return { matched: runners.length, immediate: immediate.length, delayed: later.length };
  }

  /**
   * The second wave for a boosted errand (Backend PRD 12.5, 22.5): the next eligible runners nearby, up to
   * `NEARBY_BOOST_WAVE_SIZE`, Pro or not, now. A runner who was already told is skipped *before* the wave is
   * counted, so the wave goes on to the next runners instead of repeating the nearest ones. (When both waves
   * are the same size, the second would otherwise pick the very same runners and reach nobody new.)
   */
  async onBoosted(errandId: string, occurredAt: Date): Promise<number> {
    if (!(await this.isOpen(errandId))) return 0;
    const size = await this.config.get('NEARBY_BOOST_WAVE_SIZE');
    const runners = await this.eligibleRunners(errandId, size, { skipAlreadyTold: true });
    for (const runnerId of runners) {
      await this.notify(errandId, runnerId, occurredAt);
    }
    return runners.length;
  }

  /** The delayed part of the wave. Re-checks that the errand is still open. */
  async onDelayed(errandId: string, runnerIds: string[], occurredAt: Date): Promise<number> {
    if (!(await this.isOpen(errandId))) {
      return 0;
    }
    let sent = 0;
    for (const runnerId of runnerIds) {
      if (await this.stillEligible(errandId, runnerId)) {
        await this.notify(errandId, runnerId, occurredAt);
        sent += 1;
      }
    }
    return sent;
  }

  private async notify(errandId: string, runnerId: string, occurredAt: Date): Promise<void> {
    const [errand, cap] = await Promise.all([this.errandSummary(errandId), this.config.get('NEARBY_PUSH_CAP_PER_HOUR')]);
    if (!errand) return;
    await this.notifications.notify(
      {
        userId: runnerId,
        template: 'errand.nearby',
        vars: { errandTitle: errand.title, area: errand.area },
        data: { errandId },
        dedupeKey: `errand:${errandId}:nearby:${runnerId}`,
        pushCap: { key: `nearby:${runnerId}`, limit: cap },
      },
      occurredAt,
    );
  }

  /** Nearest first, limited to the wave size. */
  private async eligibleRunners(errandId: string, limit: number, options: { skipAlreadyTold?: boolean } = {}): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT u.id::text
      FROM errands e
      JOIN runner_profiles rp ON rp.deleted_at IS NULL
      JOIN users u ON u.id = rp.user_id
      WHERE e.id = ${errandId}::uuid AND e.status = 'OPEN'::"ErrandStatus" AND e.deleted_at IS NULL
        AND e.expires_at > clock_timestamp() AND e.feed_point IS NOT NULL
        AND ${ELIGIBLE}
        AND ${errandGeographySql(await this.config.get('INTERSTATE_ERRANDS_ENABLED'))}
        AND (${!options.skipAlreadyTold}::boolean OR NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.user_id = u.id AND n.dedupe_key = 'errand:' || e.id::text || ':nearby:' || u.id::text
        ))
      ORDER BY ST_Distance(rp.area_center, e.feed_point), u.id
      LIMIT ${limit}
    `);
    return rows.map((row) => row.id);
  }

  private async stillEligible(errandId: string, runnerId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT u.id::text
      FROM errands e
      JOIN runner_profiles rp ON rp.deleted_at IS NULL AND rp.user_id = ${runnerId}::uuid
      JOIN users u ON u.id = rp.user_id
      WHERE e.id = ${errandId}::uuid AND e.status = 'OPEN'::"ErrandStatus" AND e.deleted_at IS NULL
        AND ${ELIGIBLE}
        AND ${errandGeographySql(await this.config.get('INTERSTATE_ERRANDS_ENABLED'))}
    `);
    return rows.length > 0;
  }

  private async isOpen(errandId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM errands
      WHERE id = ${errandId}::uuid AND status = 'OPEN'::"ErrandStatus" AND deleted_at IS NULL AND expires_at > clock_timestamp()
    `;
    return rows.length > 0;
  }

  private async errandSummary(errandId: string): Promise<{ title: string; area: string } | undefined> {
    const rows = await this.prisma.$queryRaw<Array<{ title: string; area: string | null }>>`
      SELECT e.title,
             (SELECT l.area FROM errand_locations l WHERE l.errand_id = e.id AND l.deleted_at IS NULL
              ORDER BY (l.type = 'ERRAND_PICKUP'::"LocationType") DESC LIMIT 1) AS area
      FROM errands e WHERE e.id = ${errandId}::uuid
    `;
    return rows[0] ? { title: rows[0].title, area: rows[0].area ?? 'your area' } : undefined;
  }
}

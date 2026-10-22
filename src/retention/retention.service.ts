import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';

const BATCH = 1000;

/** What one retention run did, by rule. */
export type RetentionReport = Record<
  | 'notifications'
  | 'notificationDeliveries'
  | 'outboxEvents'
  | 'authSessions'
  | 'adminSessions'
  | 'offerDailyCounters'
  | 'errandViews'
  | 'analyticsEvents'
  | 'messagesRedacted',
  number
>;

/**
 * Retention rules of Backend PRD 29. Two kinds of rule:
 *
 * - Transient tables (notifications, outbox, sessions, counters, analytics) lose rows for good.
 * - Everything else is redacted in place: the row stays, the personal content goes.
 *
 * A case that is still open holds the chat of its errand: a report or a dispute with
 * `retention_hold`, or the errand's own `legal_hold`. Held content is never touched.
 * Every rule works in batches, so a first run on a large table does not hold a long lock.
 * Location history, idempotency keys, staged selfies and account anonymisation have their own
 * jobs (`RunnerLocationService.purgeExpired`, `IdempotencyService.cleanup`,
 * `VerificationExpiryService.deleteStagedSelfies`, `AccountService.anonymiseDue`).
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
  ) {}

  async runAll(batch = BATCH): Promise<RetentionReport> {
    const notifications = await this.purgeNotifications(batch);
    return {
      ...notifications,
      outboxEvents: await this.purgeOutbox(batch),
      authSessions: await this.purgeSessions('auth_sessions', batch),
      adminSessions: await this.purgeSessions('admin_sessions', batch),
      offerDailyCounters: await this.purgeOfferCounters(batch),
      errandViews: await this.purgeErrandViews(batch),
      analyticsEvents: await this.purgeAnalytics(batch),
      messagesRedacted: await this.redactMessages(batch),
    };
  }

  /** Notifications older than NOTIFICATION_RETENTION_DAYS, with their delivery rows. */
  async purgeNotifications(batch = BATCH): Promise<Pick<RetentionReport, 'notifications' | 'notificationDeliveries'>> {
    const days = await this.config.get('NOTIFICATION_RETENTION_DAYS');
    const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM notifications
      WHERE created_at < clock_timestamp() - make_interval(days => ${days}::int)
      ORDER BY created_at LIMIT ${batch}
    `;
    if (ids.length === 0) return { notifications: 0, notificationDeliveries: 0 };
    const list = ids.map((row) => row.id);
    return this.prisma.$transaction(async (tx) => {
      const deliveries = await tx.$executeRaw`DELETE FROM notification_deliveries WHERE notification_id = ANY(${list}::uuid[])`;
      const notifications = await tx.$executeRaw`DELETE FROM notifications WHERE id = ANY(${list}::uuid[])`;
      return { notifications, notificationDeliveries: deliveries };
    });
  }

  /** Published events older than OUTBOX_RETENTION_DAYS. Failed and dead-lettered events stay for an admin. */
  async purgeOutbox(batch = BATCH): Promise<number> {
    const days = await this.config.get('OUTBOX_RETENTION_DAYS');
    return this.prisma.$executeRaw`
      DELETE FROM outbox_events
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status = 'PUBLISHED'::"OutboxStatus"
          AND processed_at < clock_timestamp() - make_interval(days => ${days}::int)
        LIMIT ${batch}
      )
    `;
  }

  /** Sessions that expired or were revoked more than SESSION_RETENTION_DAYS ago. A live session is never removed. */
  async purgeSessions(table: 'auth_sessions' | 'admin_sessions', batch = BATCH): Promise<number> {
    const days = await this.config.get('SESSION_RETENTION_DAYS');
    // Table names cannot be bound: the two literals below are the only values the type allows.
    if (table === 'auth_sessions') {
      return this.prisma.$executeRaw`
        DELETE FROM auth_sessions
        WHERE id IN (
          SELECT id FROM auth_sessions
          WHERE LEAST(expires_at, COALESCE(revoked_at, expires_at)) < clock_timestamp() - make_interval(days => ${days}::int)
          LIMIT ${batch}
        )
      `;
    }
    return this.prisma.$executeRaw`
      DELETE FROM admin_sessions
      WHERE id IN (
        SELECT id FROM admin_sessions
        WHERE LEAST(expires_at, COALESCE(revoked_at, expires_at)) < clock_timestamp() - make_interval(days => ${days}::int)
        LIMIT ${batch}
      )
    `;
  }

  /**
   * Which runner opened which errand, kept only to count a boost's results ("opened by N runners"). Rows whose last
   * view is older than ERRAND_VIEW_RETENTION_DAYS are removed for good. A boost lasts a day, so nothing live needs them.
   */
  async purgeErrandViews(batch = BATCH): Promise<number> {
    const days = await this.config.get('ERRAND_VIEW_RETENTION_DAYS');
    return this.prisma.$executeRaw`
      DELETE FROM errand_views
      WHERE (errand_id, viewer_id) IN (
        SELECT errand_id, viewer_id FROM errand_views
        WHERE last_viewed_at < clock_timestamp() - make_interval(days => ${days}::int)
        LIMIT ${batch}
      )
    `;
  }

  /** Per-day offer counters from before today minus OFFER_COUNTER_RETENTION_DAYS (days are Lagos dates). */
  async purgeOfferCounters(batch = BATCH): Promise<number> {
    const days = await this.config.get('OFFER_COUNTER_RETENTION_DAYS');
    return this.prisma.$executeRaw`
      DELETE FROM offer_daily_counters
      WHERE (user_id, day_lagos) IN (
        SELECT user_id, day_lagos FROM offer_daily_counters
        WHERE day_lagos < to_char((clock_timestamp() AT TIME ZONE 'Africa/Lagos')::date - ${days}::int, 'YYYY-MM-DD')
        LIMIT ${batch}
      )
    `;
  }

  /** Raw analytics events older than ANALYTICS_RETENTION_MONTHS. */
  async purgeAnalytics(batch = BATCH): Promise<number> {
    const months = await this.config.get('ANALYTICS_RETENTION_MONTHS');
    return this.prisma.$executeRaw`
      DELETE FROM analytics_events
      WHERE id IN (
        SELECT id FROM analytics_events
        WHERE occurred_at < clock_timestamp() - make_interval(months => ${months}::int)
        LIMIT ${batch}
      )
    `;
  }

  /**
   * Redact chat text MESSAGE_RETENTION_MONTHS after the errand ended (completed, cancelled or
   * expired), unless a case holds it. The row stays as a REMOVED message so the conversation
   * keeps its shape and counts; text and system wording go, and so do image files.
   */
  async redactMessages(batch = BATCH): Promise<number> {
    const months = await this.config.get('MESSAGE_RETENTION_MONTHS');
    const rows = await this.prisma.$queryRaw<Array<{ id: string; media_id: string | null }>>`
      WITH due AS (
        SELECT m.id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        JOIN errands e ON e.id = c.errand_id
        WHERE m.status <> 'REMOVED'::"MessageStatus"
          AND e.status IN ('COMPLETED'::"ErrandStatus", 'CANCELLED'::"ErrandStatus", 'EXPIRED'::"ErrandStatus")
          AND COALESCE(e.completed_at, e.cancelled_at, e.expires_at) < clock_timestamp() - make_interval(months => ${months}::int)
          AND e.legal_hold = FALSE
          AND NOT EXISTS (
            SELECT 1 FROM reports r
            WHERE r.retention_hold = TRUE AND (r.errand_id = e.id OR r.message_id = m.id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM disputes d WHERE d.errand_id = e.id AND d.retention_hold = TRUE
          )
        ORDER BY m.created_at
        LIMIT ${batch}
        FOR UPDATE OF m SKIP LOCKED
      )
      UPDATE messages m
      SET status = 'REMOVED'::"MessageStatus", removed_at = clock_timestamp(), removal_reason = 'RETENTION',
          body = CASE WHEN m.type = 'SYSTEM'::"MessageType" THEN '' ELSE NULL END
      FROM due
      WHERE m.id = due.id
      RETURNING m.id::text, m.media_id::text
    `;
    const media = rows.map((row) => row.media_id).filter((id): id is string => id !== null);
    if (media.length > 0) {
      // The media cleanup sweeper removes the stored objects of soft-deleted rows.
      await this.prisma.$executeRaw`
        UPDATE media SET deleted_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ANY(${media}::uuid[]) AND deleted_at IS NULL
      `;
    }
    if (rows.length > 0) this.logger.log(`Redacted ${rows.length} messages past retention`);
    return rows.length;
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NotificationCategory, NotificationChannel } from '@prisma/client';
import type { Redis } from 'ioredis';
import { formatInTimeZone } from 'date-fns-tz';
import { PrismaService } from '../database/prisma.service.js';
import { NotificationPreferenceService } from '../auth/notification-preference.service.js';
import { DeviceService } from '../auth/device.service.js';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { PUSH_PROVIDER, type IPushProvider } from '../common/providers/push.provider.js';
import { EMAIL_PROVIDER, type IEmailProvider } from '../common/providers/email.provider.js';
import { renderEmail } from './email/email-layout.js';
import { emailBrand } from './email/email-brand.js';
import { notificationEmail } from './email/email-messages.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { TEMPLATE_DEFAULTS, render } from './notification-templates.js';
import type { NotificationIntent } from './notification-rules.js';

/** Where an account email's values are kept inside a notification's `data`. Never sent to push or the app. */
export const EMAIL_VARS_KEY = 'emailVars';

/** Attempts per channel before a delivery is left FAILED (the in-app notification always stays). */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** The default quiet hours when the user set none (Backend PRD 12.5, 19.2). */
const DEFAULT_QUIET = { start: '22:00', end: '06:00' };
const LAGOS = 'Africa/Lagos';

export interface NotifyResult {
  notificationId: string | null;
  /** False when the same dedupe key already produced a notification. */
  created: boolean;
}

interface ResolvedTemplate {
  category: NotificationCategory;
  title: string;
  body: string;
  email: boolean;
}

/**
 * The notification engine (Backend PRD 19). One call per intent:
 *
 *   in-app first, always (the canonical record) -> push if enabled and a device exists, not in
 *   quiet hours for marketplace notices, under the hourly cap -> email for account notices.
 *
 * A failed push or email never removes the in-app notification. The dedupe key makes a repeated
 * event produce one notification, and delivery attempts are retried per channel.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly preferences: NotificationPreferenceService,
    private readonly devices: DeviceService,
    private readonly realtime: RealtimeService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PUSH_PROVIDER) private readonly push: IPushProvider,
    @Inject(EMAIL_PROVIDER) private readonly email: IEmailProvider,
  ) {}

  async notify(intent: NotificationIntent, now: Date = new Date()): Promise<NotifyResult> {
    const template = await this.resolveTemplate(intent.template);
    if (!template) {
      return { notificationId: null, created: false };
    }

    if (intent.conversationId && (await this.isMuted(intent.userId, intent.conversationId))) {
      return { notificationId: null, created: false };
    }

    const prefs = await this.preferences.get(intent.userId);
    const enabled = (channel: NotificationChannel): boolean =>
      prefs.find((entry) => entry.category === template.category && entry.channel === channel)?.enabled ?? true;
    if (!enabled('IN_APP')) {
      return { notificationId: null, created: false };
    }

    const title = render(template.title, intent.vars);
    const body = render(template.body, intent.vars);
    const data = { ...intent.data, type: intent.template };
    // The values an account email is written from (a receipt's amount and reference) are kept with the
    // notification for the email only. Push and the live feed get `data` without them.
    const stored = template.email ? { ...data, [EMAIL_VARS_KEY]: intent.vars } : data;

    const inserted = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO notifications (user_id, category, type, title, body, data, dedupe_key)
      VALUES (${intent.userId}::uuid, ${template.category}::"NotificationCategory", ${intent.template}, ${title}, ${body},
              ${JSON.stringify(stored)}::jsonb, ${intent.dedupeKey})
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING id::text
    `;

    if (inserted.length === 0) {
      // Already notified for this fact. Finish any delivery that was left pending by a failed attempt.
      const existing = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM notifications WHERE dedupe_key = ${intent.dedupeKey}
      `;
      if (existing[0]) {
        await this.deliverPending(existing[0].id);
        return { notificationId: existing[0].id, created: false };
      }
      return { notificationId: null, created: false };
    }

    const notificationId = inserted[0].id;
    await this.planDeliveries(notificationId, intent, template, enabled, now);
    await this.realtime.publish(intent.userId, 'notification.created', {
      notificationId,
      category: template.category,
      type: intent.template,
      title,
      body,
      data,
    });
    await this.deliverPending(notificationId);
    return { notificationId, created: true };
  }

  /** Decide, per channel, whether this notification is sent or suppressed and why. */
  private async planDeliveries(
    notificationId: string,
    intent: NotificationIntent,
    template: ResolvedTemplate,
    enabled: (channel: NotificationChannel) => boolean,
    now: Date,
  ): Promise<void> {
    const rows: Array<{ channel: NotificationChannel; status: 'QUEUED' | 'SENT' | 'SUPPRESSED'; reason?: string }> = [
      { channel: 'IN_APP', status: 'SENT' },
    ];

    // Push
    if (!enabled('PUSH')) {
      rows.push({ channel: 'PUSH', status: 'SUPPRESSED', reason: 'PREFERENCE' });
    } else if (template.category === 'MARKETPLACE' && (await this.inQuietHours(intent.userId, now))) {
      rows.push({ channel: 'PUSH', status: 'SUPPRESSED', reason: 'QUIET_HOURS' });
    } else if ((await this.devices.activeTokens(intent.userId)).length === 0) {
      rows.push({ channel: 'PUSH', status: 'SUPPRESSED', reason: 'NO_DEVICE' });
    } else if (intent.pushCap && !(await this.spendCap(intent.pushCap.key, intent.pushCap.limit))) {
      rows.push({ channel: 'PUSH', status: 'SUPPRESSED', reason: 'HOURLY_CAP' });
    } else {
      rows.push({ channel: 'PUSH', status: 'QUEUED' });
    }

    // Email: account notices only
    if (template.email) {
      if (!enabled('EMAIL')) {
        rows.push({ channel: 'EMAIL', status: 'SUPPRESSED', reason: 'PREFERENCE' });
      } else if (!(await this.verifiedEmail(intent.userId))) {
        rows.push({ channel: 'EMAIL', status: 'SUPPRESSED', reason: 'NO_EMAIL' });
      } else {
        rows.push({ channel: 'EMAIL', status: 'QUEUED' });
      }
    }

    for (const row of rows) {
      await this.prisma.$executeRaw`
        INSERT INTO notification_deliveries (notification_id, channel, status, suppressed_reason, updated_at)
        VALUES (${notificationId}::uuid, ${row.channel}::"NotificationChannel", ${row.status}, ${row.reason ?? null}, now())
        ON CONFLICT (notification_id, channel) DO NOTHING
      `;
    }
  }

  /**
   * Attempt every delivery that is queued or failed with attempts left. Throws after trying all of
   * them when one is still failing, so the queue retries the event; sent deliveries are never repeated.
   */
  async deliverPending(notificationId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; channel: NotificationChannel; attempts: number; user_id: string; type: string; title: string; body: string; data: Record<string, unknown> }>
    >`
      SELECT d.id::text, d.channel::text AS channel, d.attempts, n.user_id::text, n.type, n.title, n.body, n.data
      FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
      WHERE d.notification_id = ${notificationId}::uuid AND d.status IN ('QUEUED', 'FAILED') AND d.attempts < ${MAX_DELIVERY_ATTEMPTS}
      ORDER BY d.channel
    `;
    let failing = 0;
    for (const row of rows) {
      const outcome = row.channel === 'PUSH' ? await this.sendPush(row) : await this.sendEmail(row);
      await this.prisma.$executeRaw`
        UPDATE notification_deliveries
        SET status = ${outcome.status}, provider_ref = COALESCE(${outcome.providerRef ?? null}, provider_ref),
            last_error = ${outcome.error ?? null}, attempts = attempts + 1, updated_at = now(),
            suppressed_reason = ${outcome.suppressedReason ?? null}
        WHERE id = ${row.id}::uuid
      `;
      if (outcome.status === 'FAILED' && row.attempts + 1 < MAX_DELIVERY_ATTEMPTS) {
        failing += 1;
      }
    }
    if (failing > 0) {
      throw new Error(`Notification ${notificationId}: ${failing} delivery(ies) failed and will be retried`);
    }
  }

  // ---- channels ----

  private async sendPush(row: { user_id: string; title: string; body: string; data: Record<string, unknown> }): Promise<DeliveryOutcome> {
    const tokens = await this.devices.activeTokens(row.user_id);
    if (tokens.length === 0) {
      return { status: 'SUPPRESSED', suppressedReason: 'NO_DEVICE' };
    }
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(row.data)) {
      if (key === EMAIL_VARS_KEY) continue;
      if (value !== null && value !== undefined) data[key] = String(value);
    }
    let sent: string | undefined;
    let lastError: string | undefined;
    for (const token of tokens) {
      const result = await this.push.send({ token: token.pushToken, title: row.title, body: row.body, data });
      if (result.success) {
        sent = result.messageId ?? 'sent';
      } else {
        lastError = result.error ?? 'push failed';
        if (result.invalidToken) {
          // The provider says this token is dead: stop using it (Backend PRD 19.4).
          await this.prisma.$executeRaw`UPDATE devices SET active = false, updated_at = now() WHERE id = ${token.id}::uuid`;
        }
      }
    }
    if (sent) return { status: 'SENT', providerRef: sent };
    // Every token was invalid: nothing more to try, so it is a suppression, not a retry.
    const stillActive = await this.devices.activeTokens(row.user_id);
    if (stillActive.length === 0) return { status: 'SUPPRESSED', suppressedReason: 'NO_DEVICE', error: lastError };
    return { status: 'FAILED', error: lastError };
  }

  private async sendEmail(row: { user_id: string; type: string; title: string; body: string; data: Record<string, unknown> }): Promise<DeliveryOutcome> {
    const recipient = await this.emailRecipient(row.user_id);
    if (!recipient) {
      return { status: 'SUPPRESSED', suppressedReason: 'NO_EMAIL' };
    }
    const stored = row.data[EMAIL_VARS_KEY];
    const vars: Record<string, string> =
      stored && typeof stored === 'object'
        ? Object.fromEntries(Object.entries(stored as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as Record<string, string>
        : {};
    const message = renderEmail(
      notificationEmail({ type: row.type, title: row.title, body: row.body, firstName: recipient.firstName, vars }, emailBrand()),
      emailBrand(),
    );
    const result = await this.email.send({ to: recipient.address, subject: message.subject, text: message.text, html: message.html });
    return result.success ? { status: 'SENT', providerRef: result.messageId } : { status: 'FAILED', error: result.error ?? 'email failed' };
  }

  // ---- helpers ----

  private async resolveTemplate(key: string): Promise<ResolvedTemplate | undefined> {
    const fallback = TEMPLATE_DEFAULTS[key];
    const override = await this.prisma.client.notificationTemplate.findFirst({ where: { key } });
    if (override) {
      if (!override.active) return undefined;
      return { category: override.category, title: override.titleTemplate, body: override.bodyTemplate, email: fallback?.email === true };
    }
    if (!fallback) {
      this.logger.error(`No notification template "${key}"`);
      return undefined;
    }
    return { category: fallback.category, title: fallback.title, body: fallback.body, email: fallback.email === true };
  }

  private async isMuted(userId: string, conversationId: string): Promise<boolean> {
    const row = await this.prisma.client.conversationParticipant.findFirst({
      where: { conversationId, userId },
      select: { muted: true },
    });
    return row?.muted === true;
  }

  private async verifiedEmail(userId: string): Promise<string | null> {
    return (await this.emailRecipient(userId))?.address ?? null;
  }

  /** The address to write to, and the first name to greet by. Null when there is no verified email. */
  private async emailRecipient(userId: string): Promise<{ address: string; firstName: string | null } | null> {
    const rows = await this.prisma.$queryRaw<Array<{ email: string | null; verified: boolean; first_name: string | null }>>`
      SELECT email, (email_verified_at IS NOT NULL) AS verified, first_name FROM users WHERE id = ${userId}::uuid AND deleted_at IS NULL
    `;
    return rows[0]?.email && rows[0].verified ? { address: rows[0].email, firstName: rows[0].first_name } : null;
  }

  /** The user's own quiet hours, or the default. Marketplace push only (Backend PRD 19.2). */
  async inQuietHours(userId: string, now: Date): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ s: string | null; e: string | null }>>`
      SELECT to_char(quiet_hours_start, 'HH24:MI') AS s, to_char(quiet_hours_end, 'HH24:MI') AS e
      FROM notification_preferences
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL AND quiet_hours_start IS NOT NULL AND quiet_hours_end IS NOT NULL
      LIMIT 1
    `;
    const start = rows[0]?.s ?? DEFAULT_QUIET.start;
    const end = rows[0]?.e ?? DEFAULT_QUIET.end;
    const current = formatInTimeZone(now, LAGOS, 'HH:mm');
    // A window that wraps midnight (22:00 to 06:00) is "after start or before end".
    return start <= end ? current >= start && current < end : current >= start || current < end;
  }

  /** Spend one push from an hourly allowance. Fails open when Redis is down. */
  private async spendCap(key: string, limit: number): Promise<boolean> {
    try {
      const redisKey = `notif:cap:${key}`;
      const used = await this.redis.incr(redisKey);
      if (used === 1) {
        await this.redis.expire(redisKey, 3600);
      }
      return used <= limit;
    } catch {
      return true;
    }
  }
}

interface DeliveryOutcome {
  status: 'SENT' | 'FAILED' | 'SUPPRESSED';
  providerRef?: string;
  error?: string;
  suppressedReason?: string;
}


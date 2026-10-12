import { Injectable } from '@nestjs/common';
import { NotificationCategory, NotificationChannel } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { VALIDATION_ERROR } from '../common/constants/error-codes.js';

export interface QuietHours {
  /** HH:mm in Lagos time. */
  start: string;
  end: string;
  /** True when the user set none and the platform default applies. */
  isDefault: boolean;
}

/** The default quiet window when the user set none (Backend PRD 12.5, 19.2). */
export const DEFAULT_QUIET_HOURS = { start: '22:00', end: '06:00' };

export interface PreferenceEntry {
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
}

/** Notifications the user cannot switch off: they carry account, payment and safety information. */
const ALWAYS_ON: NotificationCategory[] = [NotificationCategory.TRANSACTIONAL, NotificationCategory.SAFETY];

/**
 * Notification preferences (Backend PRD 9.6, section 17). The result is always the
 * complete matrix of category x channel. Defaults: everything on, except MARKETING
 * which is opt-in (it also needs the separate marketing consent).
 */
@Injectable()
export class NotificationPreferenceService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<PreferenceEntry[]> {
    const stored = await this.prisma.client.notificationPreference.findMany({ where: { userId } });
    const byKey = new Map(stored.map((pref) => [`${pref.category}:${pref.channel}`, pref.enabled]));

    const matrix: PreferenceEntry[] = [];
    for (const category of Object.values(NotificationCategory)) {
      for (const channel of Object.values(NotificationChannel)) {
        matrix.push({
          category,
          channel,
          enabled: byKey.get(`${category}:${channel}`) ?? category !== NotificationCategory.MARKETING,
        });
      }
    }
    return matrix;
  }

  /** The user's quiet hours, or the default. Quiet hours hold back marketplace push notices only. */
  async getQuietHours(userId: string): Promise<QuietHours> {
    const rows = await this.prisma.$queryRaw<Array<{ s: string | null; e: string | null }>>`
      SELECT to_char(quiet_hours_start, 'HH24:MI') AS s, to_char(quiet_hours_end, 'HH24:MI') AS e
      FROM notification_preferences
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
        AND quiet_hours_start IS NOT NULL AND quiet_hours_end IS NOT NULL
      LIMIT 1
    `;
    if (rows[0]?.s && rows[0]?.e) {
      return { start: rows[0].s, end: rows[0].e, isDefault: false };
    }
    return { ...DEFAULT_QUIET_HOURS, isDefault: true };
  }

  /**
   * Set quiet hours (both times) or clear them (both null, the default window applies again).
   * The window is kept on every preference row of the user, so the notification engine finds it
   * whichever row it reads.
   */
  async setQuietHours(userId: string, start: string | null, end: string | null): Promise<QuietHours> {
    if ((start === null) !== (end === null)) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'Set both a start and an end time, or neither.' });
    }
    if (start !== null && start === end) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'The start and end time must differ.' });
    }
    if (start === null) {
      await this.prisma.$executeRaw`
        UPDATE notification_preferences SET quiet_hours_start = NULL, quiet_hours_end = NULL, updated_at = now()
        WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
      `;
    } else {
      await this.prisma.$transaction([
        // The anchor row exists even when the user never changed a switch.
        this.prisma.$executeRaw`
          INSERT INTO notification_preferences (user_id, channel, category, enabled, updated_at)
          VALUES (${userId}::uuid, 'PUSH'::"NotificationChannel", 'MARKETPLACE'::"NotificationCategory", true, now())
          ON CONFLICT (user_id, channel, category) WHERE deleted_at IS NULL DO NOTHING
        `,
        this.prisma.$executeRaw`
          UPDATE notification_preferences
          SET quiet_hours_start = ${start}::time, quiet_hours_end = ${end}::time, updated_at = now()
          WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
        `,
      ]);
    }
    return this.getQuietHours(userId);
  }

  /** Set the given entries (others are untouched). Transactional and safety notices cannot be disabled. */
  async set(userId: string, entries: PreferenceEntry[]): Promise<PreferenceEntry[]> {
    const forbidden = entries.filter((entry) => ALWAYS_ON.includes(entry.category) && !entry.enabled);
    if (forbidden.length > 0) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Account, payment and safety notifications cannot be turned off.',
        details: { categories: [...new Set(forbidden.map((entry) => entry.category))] },
      });
    }

    await this.prisma.$transaction(
      entries.map(
        (entry) => this.prisma.$executeRaw`
          INSERT INTO notification_preferences (user_id, channel, category, enabled, updated_at)
          VALUES (${userId}::uuid, ${entry.channel}::"NotificationChannel", ${entry.category}::"NotificationCategory", ${entry.enabled}, now())
          ON CONFLICT (user_id, channel, category) WHERE deleted_at IS NULL
          DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
        `,
      ),
    );
    return this.get(userId);
  }
}

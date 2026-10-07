import { Injectable } from '@nestjs/common';
import { NotificationCategory, NotificationChannel } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { VALIDATION_ERROR } from '../common/constants/error-codes.js';

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

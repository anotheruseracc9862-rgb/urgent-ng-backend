import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { NotificationChannel, NotificationCategory } from '@prisma/client';

export interface NotificationPreferences {
  transactional: ChannelPreferences;
  safety: ChannelPreferences;
  marketplace: ChannelPreferences;
  messaging: ChannelPreferences;
  marketing: ChannelPreferences;
}

export interface ChannelPreferences {
  push: boolean;
  email: boolean;
  inApp: boolean;
}

export interface UpdatePreferencesData {
  transactional?: Partial<ChannelPreferences>;
  safety?: Partial<ChannelPreferences>;
  marketplace?: Partial<ChannelPreferences>;
  messaging?: Partial<ChannelPreferences>;
  marketing?: Partial<ChannelPreferences>;
}

@Injectable()
export class NotificationPreferenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get user notification preferences
   * Returns structured preferences by category and channel
   * Per PRD §9.8
   */
  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Fetch all notification preferences for this user
    const preferences = await this.prisma.notificationPreference.findMany({
      where: { userId },
    });

    // Build structured response with defaults (all enabled)
    const result: NotificationPreferences = {
      transactional: { push: true, email: true, inApp: true },
      safety: { push: true, email: true, inApp: true },
      marketplace: { push: true, email: true, inApp: true },
      messaging: { push: true, email: true, inApp: true },
      marketing: { push: true, email: true, inApp: true },
    };

    // Apply user preferences
    for (const pref of preferences) {
      const category = pref.category.toLowerCase() as keyof NotificationPreferences;
      const channel = pref.channel.toLowerCase().replace('_', '') as keyof ChannelPreferences;
      
      if (result[category] && channel in result[category]) {
        result[category][channel] = pref.enabled;
      }
    }

    return result;
  }

  /**
   * Update user notification preferences
   * Updates specific category/channel combinations
   * Per PRD §9.8
   */
  async updatePreferences(userId: string, data: UpdatePreferencesData): Promise<NotificationPreferences> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Build list of preference updates
    const updates: Array<{ category: NotificationCategory; channel: NotificationChannel; enabled: boolean }> = [];

    for (const [category, channels] of Object.entries(data)) {
      if (channels) {
        for (const [channel, enabled] of Object.entries(channels)) {
          if (typeof enabled === 'boolean') {
            const categoryEnum = category.toUpperCase() as NotificationCategory;
            const channelEnum = (channel === 'inApp' ? 'IN_APP' : channel.toUpperCase()) as NotificationChannel;
            
            updates.push({
              category: categoryEnum,
              channel: channelEnum,
              enabled,
            });
          }
        }
      }
    }

    // Execute updates in transaction
    await this.prisma.$transaction(
      updates.map((update) =>
        this.prisma.notificationPreference.upsert({
          where: {
            userId_channel_category: {
              userId,
              channel: update.channel,
              category: update.category,
            },
          },
          create: {
            userId,
            channel: update.channel,
            category: update.category,
            enabled: update.enabled,
          },
          update: {
            enabled: update.enabled,
          },
        }),
      ),
    );

    // Return updated preferences
    return this.getPreferences(userId);
  }
}

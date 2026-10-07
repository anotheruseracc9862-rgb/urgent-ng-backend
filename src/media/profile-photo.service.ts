import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Media } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BlockService } from '../auth/block.service.js';
import { ProfileService, type MeView } from '../auth/profile.service.js';
import { MediaService } from './media.service.js';
import { MediaAccessService, type MediaAccessPolicy } from './media-access.service.js';

/**
 * Profile photos (Backend PRD 9.1). Anyone signed in may see another user's current photo unless
 * one of them has blocked the other.
 */
@Injectable()
export class ProfilePhotoService implements OnModuleInit, MediaAccessPolicy {
  readonly purposes = ['PROFILE_PHOTO'] as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly access: MediaAccessService,
    private readonly blocks: BlockService,
    private readonly profile: ProfileService,
  ) {}

  onModuleInit(): void {
    this.access.register(this);
  }

  async canView(media: Pick<Media, 'id' | 'ownerId'>, viewerId: string): Promise<boolean> {
    const current = await this.prisma.client.profile.count({
      where: { userId: media.ownerId, photoMediaId: media.id },
    });
    if (current === 0) {
      return false; // an old or detached photo is private again
    }
    return !(await this.blocks.existsBetween(viewerId, media.ownerId));
  }

  /** Make a READY PROFILE_PHOTO the user's photo and remove the previous one. */
  async set(userId: string, mediaId: string): Promise<MeView> {
    const photo = await this.media.requireReadyOwned(userId, mediaId, 'PROFILE_PHOTO');

    const previous = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ photo_media_id: string | null }>>`
        SELECT photo_media_id FROM profiles WHERE user_id = ${userId}::uuid FOR UPDATE
      `;
      await tx.$executeRaw`UPDATE profiles SET photo_media_id = ${photo.id}::uuid, updated_at = now() WHERE user_id = ${userId}::uuid`;
      return rows[0]?.photo_media_id ?? null;
    });

    if (previous && previous !== photo.id) {
      const old = await this.prisma.client.media.findUnique({ where: { id: previous } });
      if (old) {
        await this.media.softDelete(old);
      }
    }
    return this.profile.getMe(userId);
  }

  async clear(userId: string): Promise<MeView> {
    const profile = await this.prisma.client.profile.findUnique({ where: { userId } });
    if (profile?.photoMediaId) {
      const old = await this.prisma.client.media.findUnique({ where: { id: profile.photoMediaId } });
      if (old) {
        await this.media.softDelete(old);
      } else {
        await this.prisma.$executeRaw`UPDATE profiles SET photo_media_id = NULL WHERE user_id = ${userId}::uuid`;
      }
    }
    return this.profile.getMe(userId);
  }
}

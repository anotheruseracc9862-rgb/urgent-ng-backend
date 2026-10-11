import { Inject, Injectable } from '@nestjs/common';
import { AuditActorType, type Media, type MediaPurpose } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { AuditService } from '../audit/audit.service.js';
import { STORAGE_PROVIDER, type IStorageProvider } from '../common/providers/storage.provider.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { FORBIDDEN, MEDIA_INVALID, MEDIA_NOT_READY, RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import type { AdminPermissionKey } from '../admin/admin.permissions.js';

export type MediaVariant = 'full' | 'thumbnail';

export interface MediaUrlResult {
  url: string;
  variant: MediaVariant;
  expiresAt: Date;
}

/**
 * Who besides the owner may view media of a purpose. Modules that own the related records
 * register one in `onModuleInit` (the conversation module for CHAT_IMAGE, the dispute module
 * for DISPUTE_EVIDENCE, and so on). A purpose with no policy is visible to its owner only.
 */
export interface MediaAccessPolicy {
  purposes: readonly MediaPurpose[];
  canView(media: Pick<Media, 'id' | 'ownerId' | 'purpose'>, viewerId: string): Promise<boolean>;
}

/** The admin permission needed to view media of each purpose (Backend PRD 23.4, 24.2). */
const ADMIN_PERMISSION: Record<MediaPurpose, AdminPermissionKey> = {
  PROFILE_PHOTO: 'USERS_VIEW',
  ERRAND_PHOTO: 'ERRANDS_VIEW',
  CHAT_IMAGE: 'CHAT_SENSITIVE_VIEW',
  PICKUP_EVIDENCE: 'DISPUTES_VIEW',
  DELIVERY_EVIDENCE: 'DISPUTES_VIEW',
  PURCHASE_RECEIPT: 'DISPUTES_VIEW',
  DISPUTE_EVIDENCE: 'DISPUTES_VIEW',
  VERIFICATION_INPUT: 'VERIFICATION_VIEW',
  OTHER: 'SENSITIVE_DATA_VIEW',
};

/**
 * Download authorisation (Backend PRD 23.4). The bucket is private. A signed URL is issued only
 * after the check here, so knowing a storage key (or a media id) gives access to nothing.
 *
 * A caller who may not see a file gets RESOURCE_NOT_FOUND, the same answer as for a missing one.
 */
@Injectable()
export class MediaAccessService {
  private readonly policies = new Map<MediaPurpose, MediaAccessPolicy>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly audit: AuditService,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
  ) {}

  register(policy: MediaAccessPolicy): void {
    for (const purpose of policy.purposes) {
      this.policies.set(purpose, policy);
    }
  }

  async urlForUser(viewerId: string, mediaId: string, variant: MediaVariant): Promise<MediaUrlResult> {
    const media = await this.prisma.client.media.findUnique({ where: { id: mediaId } });
    if (!media || !(await this.userMayView(media, viewerId))) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return this.sign(media, variant);
  }

  async urlForAdmin(
    admin: { adminId: string; permissions: readonly AdminPermissionKey[] },
    mediaId: string,
    variant: MediaVariant,
    ctx: { ip?: string; requestId?: string },
  ): Promise<MediaUrlResult> {
    const media = await this.prisma.client.media.findUnique({ where: { id: mediaId } });
    if (!media) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (!admin.permissions.includes(ADMIN_PERMISSION[media.purpose])) {
      throw DomainException.of(FORBIDDEN);
    }
    const result = await this.sign(media, variant);
    await this.audit.record({
      actorType: AuditActorType.ADMIN,
      actorId: admin.adminId,
      action: 'media.admin_viewed',
      entityType: 'media',
      entityId: media.id,
      requestId: ctx.requestId,
      ip: ctx.ip,
      metadata: { purpose: media.purpose, variant },
    });
    return result;
  }

  /**
   * A short-lived signed link to a profile photo's thumbnail for a reader who is already
   * authorised by something other than an account, such as a trusted-contact link (Backend PRD
   * 17.5). Only profile photos can be handed out this way; any other file is "not found".
   */
  async urlForSharedProfilePhoto(mediaId: string, ttlSeconds: number): Promise<MediaUrlResult | null> {
    const media = await this.prisma.client.media.findUnique({ where: { id: mediaId } });
    if (
      !media ||
      media.purpose !== 'PROFILE_PHOTO' ||
      media.status !== 'READY' ||
      media.moderationStatus === 'REMOVED' ||
      !(media.thumbnailKey ?? media.storageKey)
    ) {
      return null;
    }
    const signed = await this.storage.createPresignedDownload((media.thumbnailKey ?? media.storageKey) as string, ttlSeconds);
    return { url: signed.url, variant: 'thumbnail', expiresAt: signed.expiresAt };
  }

  private async userMayView(media: Media, viewerId: string): Promise<boolean> {
    if (media.ownerId === viewerId) {
      return media.moderationStatus !== 'REMOVED';
    }
    if (media.status !== 'READY' || media.moderationStatus === 'REMOVED') {
      return false;
    }
    const policy = this.policies.get(media.purpose);
    return policy ? policy.canView(media, viewerId) : false;
  }

  private async sign(media: Media, variant: MediaVariant): Promise<MediaUrlResult> {
    if (media.status === 'REJECTED') {
      throw DomainException.of(MEDIA_INVALID);
    }
    if (media.status !== 'READY') {
      throw DomainException.of(MEDIA_NOT_READY);
    }
    const key = variant === 'thumbnail' ? media.thumbnailKey : media.storageKey;
    if (!key) {
      throw DomainException.of(MEDIA_NOT_READY);
    }
    const signed = await this.storage.createPresignedDownload(key, await this.config.get('MEDIA_DOWNLOAD_URL_SECONDS'));
    return { url: signed.url, variant, expiresAt: signed.expiresAt };
  }
}

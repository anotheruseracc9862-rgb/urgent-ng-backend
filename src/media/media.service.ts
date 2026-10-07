import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Media, MediaPurpose } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { STORAGE_PROVIDER, type IStorageProvider } from '../common/providers/storage.provider.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { MEDIA_INVALID, MEDIA_NOT_READY, RATE_LIMITED, RESOURCE_CONFLICT } from '../common/constants/error-codes.js';
import {
  ALLOWED_IMAGE_TYPES,
  MAX_PENDING_UPLOADS,
  MEDIA_CONFIRMED_EVENT,
  REJECTION,
  isAllowedImageType,
  mediaKeys,
  type RejectionReason,
} from './media.constants.js';

export interface MediaView {
  id: string;
  purpose: MediaPurpose;
  status: Media['status'];
  moderationStatus: Media['moderationStatus'];
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  rejectionReason: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
}

export interface UploadRequestResult {
  media: MediaView;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: Date };
}

export const toMediaView = (media: Media): MediaView => ({
  id: media.id,
  purpose: media.purpose,
  status: media.status,
  moderationStatus: media.moderationStatus,
  mimeType: media.mimeType,
  sizeBytes: Number(media.sizeBytes),
  width: media.width,
  height: media.height,
  rejectionReason: media.status === 'REJECTED' ? media.rejectionReason : null,
  createdAt: media.createdAt,
  confirmedAt: media.confirmedAt,
});

/**
 * Upload flow (Backend PRD 23.1): request a presigned URL, upload straight to storage, confirm.
 * File bytes never pass through the API. Application code outside this module never touches
 * storage keys.
 *
 * Every "not yours", "not found" and "not as declared" case answers MEDIA_INVALID, so a caller
 * cannot learn whether someone else's media id exists.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly outbox: OutboxService,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
  ) {}

  /** Validate the request, create the PENDING row and sign an upload URL for exactly that file. */
  async requestUpload(
    ownerId: string,
    input: { purpose: MediaPurpose; mimeType: string; sizeBytes: number },
  ): Promise<UploadRequestResult> {
    if (!isAllowedImageType(input.mimeType)) {
      throw DomainException.of(MEDIA_INVALID, {
        message: 'Only JPEG, PNG and WebP images are accepted.',
        details: { reason: 'UNSUPPORTED_TYPE', allowed: Object.keys(ALLOWED_IMAGE_TYPES) },
      });
    }
    const maxBytes = await this.config.get('MAX_UPLOAD_BYTES');
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > maxBytes) {
      throw DomainException.of(MEDIA_INVALID, {
        message: 'The file is too large.',
        details: { reason: REJECTION.TOO_LARGE, maxBytes },
      });
    }

    const pending = await this.prisma.client.media.count({ where: { ownerId, status: 'PENDING' } });
    if (pending >= MAX_PENDING_UPLOADS) {
      throw DomainException.of(RATE_LIMITED, {
        message: 'Too many uploads are waiting to be confirmed. Confirm or cancel some first.',
      });
    }

    const id = randomUUID();
    const storageKey = mediaKeys.original(ownerId, input.purpose, id, ALLOWED_IMAGE_TYPES[input.mimeType]);
    const signed = await this.storage.createPresignedUpload({
      key: storageKey,
      contentType: input.mimeType,
      maxBytes: input.sizeBytes,
      expiresInSeconds: await this.config.get('MEDIA_UPLOAD_URL_SECONDS'),
    });

    const media = await this.prisma.client.media.create({
      data: {
        id,
        ownerId,
        purpose: input.purpose,
        storageKey,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
      },
    });

    return {
      media: toMediaView(media),
      upload: { url: signed.url, method: signed.method, headers: signed.headers, expiresAt: signed.expiresAt },
    };
  }

  /**
   * Check the uploaded object against what was requested, then queue processing.
   * Safe to repeat: once confirmed, the current state is returned and nothing is queued twice.
   */
  async confirm(ownerId: string, mediaId: string): Promise<MediaView> {
    const media = await this.findOwned(ownerId, mediaId);
    if (media.status !== 'PENDING') {
      return toMediaView(media);
    }

    const head = await this.storage.headObject(media.storageKey);
    if (!head.exists) {
      throw DomainException.of(MEDIA_INVALID, {
        message: 'The file has not been uploaded.',
        details: { reason: REJECTION.OBJECT_MISSING },
      });
    }

    const hardCap = await this.config.get('SERVER_HARD_UPLOAD_BYTES');
    const sizeOk = head.sizeBytes === Number(media.sizeBytes) && (head.sizeBytes ?? 0) <= hardCap;
    const typeOk = head.contentType === media.mimeType;
    if (!sizeOk || !typeOk) {
      await this.reject(media.id, media.storageKey, REJECTION.UPLOAD_MISMATCH);
      throw DomainException.of(MEDIA_INVALID, {
        message: 'The uploaded file does not match what was requested. Request a new upload.',
        details: { reason: REJECTION.UPLOAD_MISMATCH },
      });
    }

    const confirmed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE media
        SET status = 'PROCESSING'::"MediaStatus", confirmed_at = now(), updated_at = now()
        WHERE id = ${mediaId}::uuid AND status = 'PENDING' AND deleted_at IS NULL
        RETURNING id
      `;
      if (rows.length === 0) {
        return false; // a parallel confirm won
      }
      await this.outbox.add(tx, {
        eventType: MEDIA_CONFIRMED_EVENT,
        aggregateType: 'media',
        aggregateId: mediaId,
        payload: { mediaId },
      });
      return true;
    });
    if (!confirmed) {
      this.logger.debug(`Media ${mediaId} was confirmed by a parallel request`);
    }

    return toMediaView(await this.findOwned(ownerId, mediaId));
  }

  async get(ownerId: string, mediaId: string): Promise<MediaView> {
    return toMediaView(await this.findOwned(ownerId, mediaId));
  }

  /**
   * Owner removes a file. Allowed only for uploads still waiting or rejected, and for profile
   * photos. Files that other records can rely on (errand photos, chat images, evidence) are kept.
   */
  async remove(ownerId: string, mediaId: string): Promise<void> {
    const media = await this.findOwned(ownerId, mediaId);
    const removable = media.status === 'PENDING' || media.status === 'REJECTED' || media.purpose === 'PROFILE_PHOTO';
    if (!removable) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'This file is in use and cannot be deleted.' });
    }
    await this.softDelete(media);
  }

  /**
   * Soft delete the row (clearing a profile photo that points at it) and remove the stored
   * objects. Storage failures are logged: the cleanup sweeper does not retry rows already
   * deleted, so objects are removed first and the row second.
   */
  async softDelete(media: Pick<Media, 'id' | 'storageKey' | 'thumbnailKey'>): Promise<void> {
    await this.deleteObjects(media);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE profiles SET photo_media_id = NULL, updated_at = now() WHERE photo_media_id = ${media.id}::uuid`;
      await tx.$executeRaw`UPDATE media SET deleted_at = now(), updated_at = now() WHERE id = ${media.id}::uuid AND deleted_at IS NULL`;
    });
  }

  async deleteObjects(media: Pick<Media, 'id' | 'storageKey' | 'thumbnailKey'>): Promise<void> {
    for (const key of [media.storageKey, media.thumbnailKey]) {
      if (!key) continue;
      try {
        await this.storage.deleteObject(key);
      } catch (error) {
        this.logger.error(`Could not delete object for media ${media.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Find a READY row the owner may attach to something (profile photo, errand, message...). */
  async requireReadyOwned(ownerId: string, mediaId: string, purpose: MediaPurpose): Promise<Media> {
    const media = await this.findOwned(ownerId, mediaId);
    if (media.purpose !== purpose || media.status === 'REJECTED' || media.moderationStatus === 'REMOVED') {
      throw DomainException.of(MEDIA_INVALID);
    }
    if (media.status !== 'READY') {
      throw DomainException.of(MEDIA_NOT_READY);
    }
    return media;
  }

  private async reject(id: string, storageKey: string, reason: RejectionReason): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE media
      SET status = 'REJECTED'::"MediaStatus", rejection_reason = ${reason}, updated_at = now()
      WHERE id = ${id}::uuid AND status = 'PENDING'
    `;
    await this.deleteObjects({ id, storageKey, thumbnailKey: null });
  }

  private async findOwned(ownerId: string, mediaId: string): Promise<Media> {
    const media = await this.prisma.client.media.findFirst({ where: { id: mediaId, ownerId } });
    if (!media) {
      throw DomainException.of(MEDIA_INVALID);
    }
    return media;
  }
}

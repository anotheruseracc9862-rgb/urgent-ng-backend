import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Media } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { STORAGE_PROVIDER, type IStorageProvider } from '../common/providers/storage.provider.js';
import { detectImageType } from './image-type.js';
import { MEDIA_MODERATION_HOOK, type IMediaModerationHook } from './moderation.hook.js';
import { MediaService } from './media.service.js';
import {
  ALLOWED_IMAGE_TYPES,
  MAX_INPUT_PIXELS,
  REJECTION,
  THUMBNAIL_SIZE,
  mediaKeys,
  type ImageMime,
  type RejectionReason,
} from './media.constants.js';

export type ProcessingOutcome = 'READY' | 'FLAGGED' | 'REJECTED' | 'SKIPPED';

/**
 * Turns a confirmed upload into a safe image (Backend PRD 23.2):
 *
 * 1. checks the real file type from its bytes, not the declared one;
 * 2. re-encodes it, which removes all EXIF metadata including GPS, and applies the camera
 *    orientation first so the picture still looks right;
 * 3. scales it down to MEDIA_MAX_DIMENSION and makes a thumbnail;
 * 4. runs the moderation hook;
 * 5. replaces the original upload (which may still carry GPS data) with the processed copy.
 *
 * Retry-safe: derived objects have fixed keys, and every database change is guarded by
 * `status = 'PROCESSING'`, so a repeated or parallel run changes nothing the first one finished.
 */
@Injectable()
export class MediaProcessingService {
  private readonly logger = new Logger(MediaProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly media: MediaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(MEDIA_MODERATION_HOOK) private readonly moderation: IMediaModerationHook,
  ) {}

  async process(mediaId: string): Promise<ProcessingOutcome> {
    const media = await this.prisma.client.media.findUnique({ where: { id: mediaId } });
    if (!media || media.status !== 'PROCESSING') {
      return 'SKIPPED'; // already finished, rejected or deleted: nothing to do
    }

    const head = await this.storage.headObject(media.storageKey);
    if (!head.exists) {
      return this.reject(media, REJECTION.OBJECT_MISSING);
    }
    const hardCap = await this.config.get('SERVER_HARD_UPLOAD_BYTES');
    if ((head.sizeBytes ?? 0) > hardCap) {
      return this.reject(media, REJECTION.TOO_LARGE);
    }

    // A storage outage throws here and the job is retried.
    const original = await this.storage.getObject(media.storageKey);

    const realType = detectImageType(original);
    if (!realType) {
      return this.reject(media, REJECTION.NOT_AN_IMAGE);
    }
    if (realType !== media.mimeType) {
      return this.reject(media, REJECTION.TYPE_MISMATCH);
    }

    const maxDimension = await this.config.get('MEDIA_MAX_DIMENSION');
    let image: { data: Buffer; width: number; height: number };
    let thumbnail: Buffer;
    try {
      image = await this.encodeFull(original, realType, maxDimension);
      thumbnail = await this.encodeThumbnail(original);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.reject(media, /pixel limit/i.test(message) ? REJECTION.TOO_MANY_PIXELS : REJECTION.CORRUPT_IMAGE);
    }

    const verdict = await this.moderation.review({
      mediaId: media.id,
      ownerId: media.ownerId,
      purpose: media.purpose,
      image: image.data,
    });
    if (verdict.decision === 'REJECT') {
      return this.reject(media, REJECTION.MODERATION, 'REMOVED');
    }

    const fullKey = mediaKeys.full(media.ownerId, media.purpose, media.id, ALLOWED_IMAGE_TYPES[realType]);
    const thumbKey = mediaKeys.thumbnail(media.ownerId, media.purpose, media.id);
    await this.storage.putObject(fullKey, image.data, realType);
    await this.storage.putObject(thumbKey, thumbnail, 'image/webp');

    const checksum = createHash('sha256').update(image.data).digest('hex');
    const moderationStatus = verdict.decision === 'FLAG' ? 'FLAGGED' : 'NONE';
    const updated = await this.prisma.$executeRaw`
      UPDATE media
      SET status = 'READY'::"MediaStatus",
          moderation_status = ${moderationStatus}::"ModerationStatus",
          storage_key = ${fullKey},
          thumbnail_key = ${thumbKey},
          size_bytes = ${image.data.length},
          checksum = ${checksum},
          width = ${image.width},
          height = ${image.height},
          processed_at = now(),
          updated_at = now()
      WHERE id = ${media.id}::uuid AND status = 'PROCESSING' AND deleted_at IS NULL
    `;
    if (updated === 0) {
      return 'SKIPPED'; // finished by another run, or deleted meanwhile
    }

    // The original goes only after the processed copy is recorded.
    await this.media.deleteObjects({ id: media.id, storageKey: media.storageKey, thumbnailKey: null });
    return moderationStatus === 'FLAGGED' ? 'FLAGGED' : 'READY';
  }

  /** Called when BullMQ has used up every attempt: the owner sees a rejection instead of waiting forever. */
  async markFailed(mediaId: string): Promise<void> {
    const media = await this.prisma.client.media.findUnique({ where: { id: mediaId } });
    if (media?.status === 'PROCESSING') {
      await this.reject(media, REJECTION.PROCESSING_FAILED);
    }
  }

  /** `.rotate()` applies the EXIF orientation. Sharp then writes no metadata, so none survives. */
  private async encodeFull(original: Buffer, type: ImageMime, maxDimension: number) {
    const pipeline = sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true });
    const encoded =
      type === 'image/jpeg'
        ? pipeline.jpeg({ quality: 85, mozjpeg: true })
        : type === 'image/png'
          ? pipeline.png({ compressionLevel: 9 })
          : pipeline.webp({ quality: 85 });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }

  private encodeThumbnail(original: Buffer): Promise<Buffer> {
    return sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
  }

  /** Reject, then remove every stored object: a rejected file must not stay in the bucket. */
  private async reject(
    media: Pick<Media, 'id' | 'storageKey' | 'thumbnailKey'>,
    reason: RejectionReason,
    moderationStatus: 'NONE' | 'REMOVED' = 'NONE',
  ): Promise<ProcessingOutcome> {
    const updated = await this.prisma.$executeRaw`
      UPDATE media
      SET status = 'REJECTED'::"MediaStatus",
          rejection_reason = ${reason},
          moderation_status = ${moderationStatus}::"ModerationStatus",
          updated_at = now()
      WHERE id = ${media.id}::uuid AND status = 'PROCESSING'
    `;
    if (updated === 0) {
      return 'SKIPPED';
    }
    this.logger.warn(`Media ${media.id} rejected: ${reason}`);
    await this.media.deleteObjects(media);
    return 'REJECTED';
  }
}

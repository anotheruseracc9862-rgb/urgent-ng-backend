import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { BusinessConfigService } from '../config/business-config.service.js';
import { MediaService } from '../media/media.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { VALIDATION_ERROR } from '../common/constants/error-codes.js';

/**
 * Photos on an errand (Backend PRD 11.1): up to the configured limit (default 6), each a READY
 * upload of purpose ERRAND_PHOTO that belongs to the requester. The list given is the whole list,
 * in display order; photos not in it are removed from the errand (the files stay for the cleanup job).
 */
@Injectable()
export class ErrandPhotosService {
  constructor(
    private readonly config: BusinessConfigService,
    private readonly media: MediaService,
  ) {}

  async set(tx: Prisma.TransactionClient, requesterId: string, errandId: string, mediaIds: string[]): Promise<void> {
    const max = await this.config.get('MAX_ERRAND_PHOTOS');
    if (mediaIds.length > max) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: `An errand can have at most ${max} photos.`,
        details: { field: 'photoMediaIds', max },
      });
    }
    for (const mediaId of mediaIds) {
      await this.media.requireReadyOwned(requesterId, mediaId, 'ERRAND_PHOTO');
    }

    const current = await tx.errandMedia.findMany({ where: { errandId, deletedAt: null } });
    const keep = new Set(mediaIds);
    const removed = current.filter((row) => !keep.has(row.mediaId));
    if (removed.length > 0) {
      await tx.errandMedia.updateMany({ where: { id: { in: removed.map((row) => row.id) } }, data: { deletedAt: new Date() } });
    }
    const existing = new Map(current.map((row) => [row.mediaId, row]));
    for (const [position, mediaId] of mediaIds.entries()) {
      const row = existing.get(mediaId);
      if (!row) {
        await tx.errandMedia.create({ data: { errandId, mediaId, position } });
      } else if (row.position !== position) {
        await tx.errandMedia.update({ where: { id: row.id }, data: { position } });
      }
    }
  }

  async list(client: Pick<Prisma.TransactionClient, 'errandMedia'>, errandId: string): Promise<Array<{ mediaId: string; position: number }>> {
    const rows = await client.errandMedia.findMany({ where: { errandId, deletedAt: null }, orderBy: { position: 'asc' } });
    return rows.map((row) => ({ mediaId: row.mediaId, position: row.position }));
  }

  /** Every attached photo is still a usable upload (publishing re-checks, an upload can be removed later). */
  async assertAllReady(client: Pick<Prisma.TransactionClient, 'errandMedia'>, requesterId: string, errandId: string): Promise<void> {
    const rows = await client.errandMedia.findMany({ where: { errandId, deletedAt: null } });
    for (const row of rows) {
      await this.media.requireReadyOwned(requesterId, row.mediaId, 'ERRAND_PHOTO');
    }
  }
}

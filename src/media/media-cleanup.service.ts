import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { MediaService } from './media.service.js';
import { MEDIA_CONFIRMED_EVENT } from './media.constants.js';

/** A PROCESSING row untouched for this long is queued again. */
const STUCK_MINUTES = 10;
const BATCH = 100;

interface StoredFile {
  id: string;
  storageKey: string;
  thumbnailKey: string | null;
}

/**
 * Housekeeping for media (Backend PRD 23.4). All time comparisons use the database clock.
 * Run by the scheduler through MediaCleanupSweeper.
 */
@Injectable()
export class MediaCleanupService {
  private readonly logger = new Logger(MediaCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly media: MediaService,
    private readonly outbox: OutboxService,
  ) {}

  /** Uploads requested but never confirmed within MEDIA_ORPHAN_HOURS: delete the object and the row. */
  async deleteOrphanUploads(limit = BATCH): Promise<number> {
    const hours = await this.config.get('MEDIA_ORPHAN_HOURS');
    const due = await this.prisma.$queryRaw<StoredFile[]>`
      SELECT id, storage_key AS "storageKey", thumbnail_key AS "thumbnailKey"
      FROM media
      WHERE status = 'PENDING' AND deleted_at IS NULL
        AND created_at < now() - make_interval(hours => ${hours}::int)
      ORDER BY created_at
      LIMIT ${limit}
    `;
    let deleted = 0;
    for (const row of due) {
      // Claim the row first: a confirm that arrives later no longer finds it.
      const claimed = await this.prisma.$executeRaw`
        UPDATE media SET deleted_at = now(), updated_at = now()
        WHERE id = ${row.id}::uuid AND status = 'PENDING' AND deleted_at IS NULL
      `;
      if (claimed === 0) continue;
      await this.media.deleteObjects(row);
      deleted += 1;
    }
    return deleted;
  }

  /** Media of anonymised accounts is personal data: remove the files, keep the row as a record. */
  async deleteMediaOfAnonymisedUsers(limit = BATCH): Promise<number> {
    const due = await this.prisma.$queryRaw<StoredFile[]>`
      SELECT m.id, m.storage_key AS "storageKey", m.thumbnail_key AS "thumbnailKey"
      FROM media m
      JOIN users u ON u.id = m.owner_id
      WHERE u.anonymised_at IS NOT NULL AND m.deleted_at IS NULL
      ORDER BY m.created_at
      LIMIT ${limit}
    `;
    let deleted = 0;
    for (const row of due) {
      try {
        await this.media.softDelete(row);
        deleted += 1;
      } catch (error) {
        this.logger.error(`Could not clean up media ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return deleted;
  }

  /**
   * Confirmed uploads whose processing job never finished (worker down, job lost). Touching
   * `updated_at` means a row is requeued at most once per STUCK_MINUTES.
   */
  async requeueStuckProcessing(limit = BATCH): Promise<number> {
    const stuck = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM media
      WHERE status = 'PROCESSING' AND deleted_at IS NULL
        AND updated_at < now() - make_interval(mins => ${STUCK_MINUTES}::int)
      ORDER BY updated_at
      LIMIT ${limit}
    `;
    let requeued = 0;
    for (const { id } of stuck) {
      const done = await this.prisma.$transaction(async (tx) => {
        const touched = await tx.$executeRaw`
          UPDATE media SET updated_at = now()
          WHERE id = ${id}::uuid AND status = 'PROCESSING'
            AND updated_at < now() - make_interval(mins => ${STUCK_MINUTES}::int)
        `;
        if (touched === 0) return false;
        await this.outbox.add(tx, {
          eventType: MEDIA_CONFIRMED_EVENT,
          aggregateType: 'media',
          aggregateId: id,
          payload: { mediaId: id },
        });
        return true;
      });
      if (done) requeued += 1;
    }
    return requeued;
  }
}


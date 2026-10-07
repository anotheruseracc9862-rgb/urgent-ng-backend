import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { MediaCleanupService } from '../media/media-cleanup.service.js';

/** Deletes abandoned uploads and media of anonymised accounts, and requeues stuck processing. */
@Injectable()
export class MediaCleanupSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly cleanup: MediaCleanupService,
  ) {
    super(prisma, 'MediaCleanupSweeper');
  }

  protected async processBatch(): Promise<number> {
    const orphans = await this.cleanup.deleteOrphanUploads();
    const anonymised = await this.cleanup.deleteMediaOfAnonymisedUsers();
    const requeued = await this.cleanup.requeueStuckProcessing();
    return orphans + anonymised + requeued;
  }
}

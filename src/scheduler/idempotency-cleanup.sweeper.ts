import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { IdempotencyService } from '../common/idempotency/idempotency.service.js';

/**
 * Sweeper that cleans up expired idempotency keys.
 * Runs every 60 seconds and removes keys older than 24 hours.
 * Per PRD §6.4 and §25.3.
 */
@Injectable()
export class IdempotencyCleanupSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly idempotencyService: IdempotencyService,
  ) {
    super(prisma, 'IdempotencyCleanupSweeper');
  }

  protected async processBatch(): Promise<number> {
    // Cleanup keys older than 24 hours
    return this.idempotencyService.cleanup(24);
  }
}

import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { RunnerLocationService } from '../locations/runner-location.service.js';

/** Removes location history older than `LOCATION_HISTORY_RETENTION_DAYS` (Backend PRD 17.6). */
@Injectable()
export class LocationRetentionSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly locations: RunnerLocationService,
  ) {
    super(prisma, 'LocationRetentionSweeper');
  }

  protected async processBatch(): Promise<number> {
    return this.locations.purgeExpired();
  }
}

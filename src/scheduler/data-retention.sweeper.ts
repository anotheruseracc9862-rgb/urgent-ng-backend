import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { RetentionService } from '../retention/retention.service.js';

/** Applies the retention rules of Backend PRD 29 once an hour. Each rule works in batches. */
@Injectable()
export class DataRetentionSweeper extends BaseSweeper {
  protected override readonly intervalMs = 60 * 60 * 1000;

  constructor(
    prisma: PrismaService,
    private readonly retention: RetentionService,
  ) {
    super(prisma, 'DataRetentionSweeper');
  }

  protected async processBatch(): Promise<number> {
    const report = await this.retention.runAll();
    return Object.values(report).reduce((sum, n) => sum + n, 0);
  }
}

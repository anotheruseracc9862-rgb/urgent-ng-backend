import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { ExecutionService } from '../execution/execution.service.js';

/** Completes delivered errands the requester did not answer within the window (Backend PRD 15.2, 25.3). */
@Injectable()
export class AutoCompletionSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly execution: ExecutionService,
  ) {
    super(prisma, 'AutoCompletionSweeper');
  }

  protected async processBatch(): Promise<number> {
    return this.execution.autoCompleteDue();
  }
}

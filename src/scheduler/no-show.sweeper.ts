import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { NoShowService } from '../reliability/no-show.service.js';

/** Confirms no-show reports whose person did not answer within the prompt window (Backend PRD 21.1). */
@Injectable()
export class NoShowSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly noShows: NoShowService,
  ) {
    super(prisma, 'NoShowSweeper');
  }

  protected async processBatch(): Promise<number> {
    return this.noShows.confirmDue();
  }
}

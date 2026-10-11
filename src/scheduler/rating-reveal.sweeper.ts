import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { RatingService } from '../ratings/rating.service.js';

/** Reveals ratings whose window closed without the other side rating (Backend PRD 20.3). */
@Injectable()
export class RatingRevealSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly ratings: RatingService,
  ) {
    super(prisma, 'RatingRevealSweeper');
  }

  protected async processBatch(): Promise<number> {
    return this.ratings.revealDue();
  }
}

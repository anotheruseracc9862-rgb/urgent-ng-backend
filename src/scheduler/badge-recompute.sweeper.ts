import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { BadgeService } from '../badges/badge.service.js';

const BATCH = 100;

/**
 * The nightly full recompute (Backend PRD 21.5): every sweep recomputes the users whose badges
 * are more than a day old, a batch at a time, so the whole base is covered each day and a missed
 * event is repaired within 24 hours.
 */
@Injectable()
export class BadgeRecomputeSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly badges: BadgeService,
  ) {
    super(prisma, 'BadgeRecomputeSweeper');
  }

  protected async processBatch(): Promise<number> {
    const due = await this.badges.dueForRecompute(BATCH);
    let done = 0;
    for (const userId of due) {
      try {
        await this.badges.recompute(userId);
        done += 1;
      } catch (error) {
        this.logger.error(`Badge recompute failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return done;
  }
}

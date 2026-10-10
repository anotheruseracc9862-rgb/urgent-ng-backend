import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { ReminderService } from '../notifications/reminder.service.js';

/** Sends the scheduled reminders that are due (Backend PRD 19.1, P8-05). */
@Injectable()
export class ReminderSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly reminders: ReminderService,
  ) {
    super(prisma, 'ReminderSweeper');
  }

  protected async processBatch(): Promise<number> {
    const counts = await this.reminders.run();
    return counts.acceptanceWarnings + counts.errandExpiring + counts.ratingReminders;
  }
}

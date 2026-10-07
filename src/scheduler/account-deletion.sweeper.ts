import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { AccountService } from '../auth/account.service.js';

/**
 * Finishes account deletion (Backend PRD 9.5): after the grace period an account becomes
 * DELETED, and after ANONYMISATION_DAYS its personal data is scrubbed.
 */
@Injectable()
export class AccountDeletionSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly accounts: AccountService,
  ) {
    super(prisma, 'AccountDeletionSweeper');
  }

  protected async processBatch(): Promise<number> {
    const deleted = await this.accounts.finalizeDueDeletions();
    const anonymised = await this.accounts.anonymiseDue();
    return deleted + anonymised;
  }
}

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { AccountDeletionSweeper } from './account-deletion.sweeper.js';
import { MediaCleanupSweeper } from './media-cleanup.sweeper.js';
import { VerificationSweeper } from './verification.sweeper.js';
import { ErrandExpirySweeper } from './errand-expiry.sweeper.js';
import { IdempotencyCleanupSweeper } from './idempotency-cleanup.sweeper.js';

/**
 * The list of sweepers the scheduler process runs. Add new sweepers to the
 * constructor and to `all`.
 */
@Injectable()
export class SweeperRegistry implements OnModuleDestroy {
  private readonly all: BaseSweeper[];

  constructor(
    idempotencyCleanup: IdempotencyCleanupSweeper,
    accountDeletion: AccountDeletionSweeper,
    mediaCleanup: MediaCleanupSweeper,
    verification: VerificationSweeper,
    errandExpiry: ErrandExpirySweeper,
  ) {
    this.all = [idempotencyCleanup, accountDeletion, mediaCleanup, verification, errandExpiry];
  }

  startAll(): void {
    for (const sweeper of this.all) {
      sweeper.start();
    }
  }

  stopAll(): void {
    for (const sweeper of this.all) {
      sweeper.stop();
    }
  }

  onModuleDestroy(): void {
    this.stopAll();
  }
}

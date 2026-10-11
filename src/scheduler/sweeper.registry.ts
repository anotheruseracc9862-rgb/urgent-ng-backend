import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { AccountDeletionSweeper } from './account-deletion.sweeper.js';
import { MediaCleanupSweeper } from './media-cleanup.sweeper.js';
import { VerificationSweeper } from './verification.sweeper.js';
import { ErrandExpirySweeper } from './errand-expiry.sweeper.js';
import { AssignmentAcceptanceSweeper } from './assignment-acceptance.sweeper.js';
import { AutoCompletionSweeper } from './auto-completion.sweeper.js';
import { ChangeRequestExpirySweeper } from './change-request-expiry.sweeper.js';
import { ReminderSweeper } from './reminder.sweeper.js';
import { RatingRevealSweeper } from './rating-reveal.sweeper.js';
import { NoShowSweeper } from './no-show.sweeper.js';
import { EnforcementExpirySweeper } from './enforcement-expiry.sweeper.js';
import { BadgeRecomputeSweeper } from './badge-recompute.sweeper.js';
import { LocationRetentionSweeper } from './location-retention.sweeper.js';
import { TrustedLinkExpirySweeper } from './trusted-link-expiry.sweeper.js';
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
    assignmentAcceptance: AssignmentAcceptanceSweeper,
    autoCompletion: AutoCompletionSweeper,
    changeRequestExpiry: ChangeRequestExpirySweeper,
    reminders: ReminderSweeper,
    ratingReveal: RatingRevealSweeper,
    noShows: NoShowSweeper,
    enforcementExpiry: EnforcementExpirySweeper,
    badgeRecompute: BadgeRecomputeSweeper,
    locationRetention: LocationRetentionSweeper,
    trustedLinkExpiry: TrustedLinkExpirySweeper,
  ) {
    this.all = [idempotencyCleanup, accountDeletion, mediaCleanup, verification, errandExpiry, assignmentAcceptance, autoCompletion, changeRequestExpiry, reminders, ratingReveal, noShows, enforcementExpiry, badgeRecompute, locationRetention, trustedLinkExpiry];
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

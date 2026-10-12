import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { IdempotencyCleanupSweeper } from './idempotency-cleanup.sweeper.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccountDeletionSweeper } from './account-deletion.sweeper.js';
import { MediaModule } from '../media/media.module.js';
import { MediaCleanupSweeper } from './media-cleanup.sweeper.js';
import { VerificationModule } from '../verification/verification.module.js';
import { VerificationSweeper } from './verification.sweeper.js';
import { ErrandsModule } from '../errands/errands.module.js';
import { ErrandExpirySweeper } from './errand-expiry.sweeper.js';
import { AssignmentsModule } from '../assignments/assignments.module.js';
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
import { BoostExpirySweeper, ReconciliationSweeper, SubscriptionSweeper } from './billing.sweepers.js';
import { BillingModule } from '../billing/billing.module.js';
import { BoostsModule } from '../boosts/boosts.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { TrustedContactModule } from '../trusted-contact/trusted-contact.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { BadgesModule } from '../badges/badges.module.js';
import { EnforcementModule } from '../enforcement/enforcement.module.js';
import { ReliabilityModule } from '../reliability/reliability.module.js';
import { RatingsModule } from '../ratings/ratings.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ExecutionModule } from '../execution/execution.module.js';
import { SweeperRegistry } from './sweeper.registry.js';
import { DataRetentionSweeper } from './data-retention.sweeper.js';
import { RetentionModule } from '../retention/retention.module.js';

/**
 * Sweepers (due-row jobs). Register each new sweeper in SweeperRegistry.
 * Only the scheduler process starts them.
 */
@Module({
  imports: [DatabaseModule, IdempotencyModule, AuthModule, MediaModule, VerificationModule, ErrandsModule, AssignmentsModule, ExecutionModule, NotificationsModule, RatingsModule, ReliabilityModule, EnforcementModule, BadgesModule, LocationsModule, TrustedContactModule, BillingModule, BoostsModule, SubscriptionsModule, RetentionModule],
  providers: [IdempotencyCleanupSweeper, AccountDeletionSweeper, MediaCleanupSweeper, VerificationSweeper, ErrandExpirySweeper, AssignmentAcceptanceSweeper, AutoCompletionSweeper, ChangeRequestExpirySweeper, ReminderSweeper, RatingRevealSweeper, NoShowSweeper, EnforcementExpirySweeper, BadgeRecomputeSweeper, LocationRetentionSweeper, TrustedLinkExpirySweeper, BoostExpirySweeper, SubscriptionSweeper, ReconciliationSweeper, DataRetentionSweeper, SweeperRegistry],
  exports: [SweeperRegistry],
})
export class SchedulerModule {}

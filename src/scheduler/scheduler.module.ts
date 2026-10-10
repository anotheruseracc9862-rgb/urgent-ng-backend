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
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ExecutionModule } from '../execution/execution.module.js';
import { SweeperRegistry } from './sweeper.registry.js';

/**
 * Sweepers (due-row jobs). Register each new sweeper in SweeperRegistry.
 * Only the scheduler process starts them.
 */
@Module({
  imports: [DatabaseModule, IdempotencyModule, AuthModule, MediaModule, VerificationModule, ErrandsModule, AssignmentsModule, ExecutionModule, NotificationsModule],
  providers: [IdempotencyCleanupSweeper, AccountDeletionSweeper, MediaCleanupSweeper, VerificationSweeper, ErrandExpirySweeper, AssignmentAcceptanceSweeper, AutoCompletionSweeper, ChangeRequestExpirySweeper, ReminderSweeper, SweeperRegistry],
  exports: [SweeperRegistry],
})
export class SchedulerModule {}

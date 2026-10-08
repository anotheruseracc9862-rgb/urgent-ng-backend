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
import { SweeperRegistry } from './sweeper.registry.js';

/**
 * Sweepers (due-row jobs). Register each new sweeper in SweeperRegistry.
 * Only the scheduler process starts them.
 */
@Module({
  imports: [DatabaseModule, IdempotencyModule, AuthModule, MediaModule, VerificationModule, ErrandsModule],
  providers: [IdempotencyCleanupSweeper, AccountDeletionSweeper, MediaCleanupSweeper, VerificationSweeper, ErrandExpirySweeper, SweeperRegistry],
  exports: [SweeperRegistry],
})
export class SchedulerModule {}

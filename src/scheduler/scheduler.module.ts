import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { IdempotencyCleanupSweeper } from './idempotency-cleanup.sweeper.js';
import { SweeperRegistry } from './sweeper.registry.js';

/**
 * Sweepers (due-row jobs). Register each new sweeper in SweeperRegistry.
 * Only the scheduler process starts them.
 */
@Module({
  imports: [DatabaseModule, IdempotencyModule],
  providers: [IdempotencyCleanupSweeper, SweeperRegistry],
  exports: [SweeperRegistry],
})
export class SchedulerModule {}

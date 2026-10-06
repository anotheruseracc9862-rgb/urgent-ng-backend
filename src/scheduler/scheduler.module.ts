import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { DelayedJobHelper } from './delayed-job.helper.js';
import { IdempotencyCleanupSweeper } from './idempotency-cleanup.sweeper.js';

@Module({
  imports: [DatabaseModule, QueueModule, IdempotencyModule],
  providers: [DelayedJobHelper, IdempotencyCleanupSweeper],
  exports: [DelayedJobHelper],
})
export class SchedulerModule {}

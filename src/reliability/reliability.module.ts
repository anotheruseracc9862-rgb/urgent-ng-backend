import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { NoShowService } from './no-show.service.js';
import { ReliabilityController } from './reliability.controller.js';
import { ReliabilityEventHandler } from './reliability.handler.js';
import { ReliabilityService } from './reliability.service.js';

/**
 * Reliability events, the rolling-window points and no-show reports (Backend PRD 21.1). Modules
 * that decide a case (disputes, reports, enforcement) write facts through ReliabilityService.
 */
@Module({
  imports: [AuthModule, AuditModule, ConfigStoreModule, DatabaseModule, IdempotencyModule, QueueModule],
  controllers: [ReliabilityController],
  providers: [ReliabilityService, NoShowService, ReliabilityEventHandler],
  exports: [ReliabilityService, NoShowService],
})
export class ReliabilityModule {}

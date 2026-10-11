import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { BoostEventHandler } from './boost-event.handler.js';
import { BoostService } from './boost.service.js';

/**
 * Boost lifecycle (Backend PRD 22.5). Buying one is an order and lives in BillingModule, which
 * imports this module; this module must never import BillingModule.
 */
@Module({
  imports: [AuditModule, ConfigStoreModule, DatabaseModule, QueueModule],
  providers: [BoostService, BoostEventHandler],
  exports: [BoostService],
})
export class BoostsModule {}

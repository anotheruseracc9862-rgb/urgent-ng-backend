import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { ProSubscriptionService } from './pro-subscription.service.js';

/**
 * Runner Pro subscription state (Backend PRD 22.4). Charging belongs to BillingModule, which
 * imports this module; this module must never import BillingModule.
 */
@Module({
  imports: [AuditModule, ConfigStoreModule, DatabaseModule, QueueModule],
  providers: [ProSubscriptionService],
  exports: [ProSubscriptionService],
})
export class SubscriptionsModule {}

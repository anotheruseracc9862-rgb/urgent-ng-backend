import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { BoostsModule } from '../boosts/boosts.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { RiskModule } from '../risk/risk.module.js';
import { BillingController, BoostPurchaseController, ProSubscriptionController, WebhookController } from './billing.controller.js';
import { OrderService } from './order.service.js';
import { PaymentSettlementService } from './payment-settlement.service.js';
import { ProRenewalService } from './pro-renewal.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { RefundService } from './refund.service.js';
import { WebhookService } from './webhook.service.js';

/**
 * Urgent.ng's own purchases (Backend PRD 22): orders, payments, webhooks, refunds, renewals and
 * reconciliation. The payment gateway comes from the global ProvidersModule. Boost and Pro state
 * live in their own modules, which this one imports; neither may import this one.
 */
@Module({
  imports: [
    AuthModule,
    AuditModule,
    ConfigStoreModule,
    DatabaseModule,
    IdempotencyModule,
    QueueModule,
    NotificationsModule,
    VerificationModule,
    BoostsModule,
    SubscriptionsModule,
    RiskModule,
  ],
  controllers: [BillingController, BoostPurchaseController, ProSubscriptionController, WebhookController],
  providers: [OrderService, PaymentSettlementService, WebhookService, RefundService, ProRenewalService, ReconciliationService],
  exports: [OrderService, PaymentSettlementService, RefundService, ProRenewalService, ReconciliationService],
})
export class BillingModule {}

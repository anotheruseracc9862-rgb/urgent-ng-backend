import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { EntitlementsModule } from '../entitlements/entitlements.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { RunnerModule } from '../runner/runner.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { OffersController } from './offers.controller.js';
import { OfferService } from './offer.service.js';
import { OfferListService } from './offer-list.service.js';

@Module({
  imports: [
    AuthModule,
    AuditModule,
    ConfigStoreModule,
    DatabaseModule,
    EntitlementsModule,
    IdempotencyModule,
    QueueModule,
    RunnerModule,
    VerificationModule,
  ],
  controllers: [OffersController],
  providers: [OfferService, OfferListService],
  exports: [OfferService, OfferListService],
})
export class OffersModule {}

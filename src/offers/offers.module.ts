import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { EntitlementsModule } from '../entitlements/entitlements.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { OffersController } from './offers.controller.js';
import { OfferService } from './offer.service.js';
import { OfferListService } from './offer-list.service.js';

@Module({
  imports: [AuthModule, EntitlementsModule, ConfigStoreModule, DatabaseModule, QueueModule],
  controllers: [OffersController],
  providers: [OfferService, OfferListService],
  exports: [OfferService, OfferListService],
})
export class OffersModule {}

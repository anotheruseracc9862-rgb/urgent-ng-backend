import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { MediaModule } from '../media/media.module.js';
import { ReferenceDataModule } from '../reference-data/reference-data.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { OffersModule } from '../offers/offers.module.js';
import { ErrandLocationRepository } from './errand-location.repository.js';
import { ErrandStateService } from './errand-state.service.js';
import { LocationPrivacyService } from './location-privacy.service.js';
import { ErrandContactService } from './errand-contact.service.js';
import { ErrandPhotosService } from './errand-photos.service.js';
import { ProhibitedItemsService } from './prohibited-items.service.js';
import { ErrandViewService } from './errand-view.service.js';
import { ErrandValidatorService } from './errand-validator.service.js';
import { ErrandService } from './errand.service.js';
import { ErrandLifecycleService } from './errand-lifecycle.service.js';
import { ErrandExpiryService } from './errand-expiry.service.js';
import { ErrandQueryService } from './errand-query.service.js';
import { ErrandsController } from './errands.controller.js';
import { OfferReconfirmationHookImpl, OFFER_RECONFIRMATION_HOOK } from './offer-reconfirmation.hook.js';

/**
 * Errands (Backend PRD section 11). `ErrandStateService` is the only way to change an errand's
 * status; other modules (offers, assignments, execution, disputes) call it inside their own
 * transaction.
 */
@Module({
  imports: [AuthModule, AuditModule, QueueModule, MediaModule, ReferenceDataModule, IdempotencyModule, OffersModule],
  controllers: [ErrandsController],
  providers: [
    ErrandLocationRepository,
    LocationPrivacyService,
    ErrandStateService,
    ErrandContactService,
    ErrandPhotosService,
    ProhibitedItemsService,
    ErrandViewService,
    ErrandValidatorService,
    ErrandService,
    ErrandLifecycleService,
    ErrandExpiryService,
    ErrandQueryService,
    { provide: OFFER_RECONFIRMATION_HOOK, useClass: OfferReconfirmationHookImpl },
  ],
  exports: [
    ErrandLocationRepository,
    LocationPrivacyService,
    ErrandStateService,
    ErrandViewService,
    ErrandService,
    ErrandLifecycleService,
    ErrandExpiryService,
    OFFER_RECONFIRMATION_HOOK,
  ],
})
export class ErrandsModule {}

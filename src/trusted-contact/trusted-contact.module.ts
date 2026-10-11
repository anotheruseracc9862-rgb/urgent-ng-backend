import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { MediaModule } from '../media/media.module.js';
import { RatingsModule } from '../ratings/ratings.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { ReportsModule } from '../reports/reports.module.js';
import { TrustedContactService } from './trusted-contact.service.js';
import { SharedLinkController, TrustedContactController } from './trusted-contact.controller.js';

/** Read-only links for a trusted contact (Backend PRD 17.5). */
@Module({
  imports: [
    AuthModule,
    AuditModule,
    ConfigStoreModule,
    DatabaseModule,
    IdempotencyModule,
    QueueModule,
    MediaModule,
    RatingsModule,
    VerificationModule,
    LocationsModule,
    ReportsModule,
  ],
  controllers: [TrustedContactController, SharedLinkController],
  providers: [TrustedContactService],
  exports: [TrustedContactService],
})
export class TrustedContactModule {}

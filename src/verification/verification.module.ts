import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { MediaModule } from '../media/media.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { VerificationController } from './verification.controller.js';
import { VerificationService } from './verification.service.js';
import { VerificationStatusService } from './verification-status.service.js';
import { VerificationAdminService } from './verification-admin.service.js';
import { VerificationExpiryService } from './verification-expiry.service.js';

/**
 * Runner identity verification (Backend PRD section 10). `VerificationStatusService` answers
 * "is this user verified right now"; the eligibility service in RunnerModule builds on it.
 * `VerificationAdminService` holds the admin actions the admin console (P11) will call.
 */
@Module({
  imports: [AuthModule, AuditModule, ConfigStoreModule, QueueModule, MediaModule, IdempotencyModule],
  controllers: [VerificationController],
  providers: [VerificationService, VerificationStatusService, VerificationAdminService, VerificationExpiryService],
  exports: [VerificationService, VerificationStatusService, VerificationAdminService, VerificationExpiryService],
})
export class VerificationModule {}

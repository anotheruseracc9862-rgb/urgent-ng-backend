import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { MediaModule } from '../media/media.module.js';
import { ErrandsModule } from '../errands/errands.module.js';
import { ReliabilityModule } from '../reliability/reliability.module.js';
import { EnforcementModule } from '../enforcement/enforcement.module.js';
import { CaseDeletionBlocker } from './case-deletion-blocker.js';
import { DisputeMediaAccess } from './dispute-media.access.js';
import { DisputeService } from './dispute.service.js';
import { DisputesController } from './disputes.controller.js';
import { EvidenceService } from './evidence.service.js';

/**
 * Disputes and the evidence service shared with reports (Backend PRD 21.3). The errand status
 * only ever changes through ErrandStateService.
 */
@Module({
  imports: [AuthModule, AuditModule, ConfigStoreModule, DatabaseModule, IdempotencyModule, QueueModule, MediaModule, ErrandsModule, ReliabilityModule, EnforcementModule],
  controllers: [DisputesController],
  providers: [DisputeService, EvidenceService, DisputeMediaAccess, CaseDeletionBlocker],
  exports: [DisputeService, EvidenceService],
})
export class DisputesModule {}

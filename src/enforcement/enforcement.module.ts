import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { ErrandsModule } from '../errands/errands.module.js';
import { RatingsModule } from '../ratings/ratings.module.js';
import { ReliabilityModule } from '../reliability/reliability.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { EnforcementController } from './enforcement.controller.js';
import { EnforcementEventHandler } from './enforcement.handler.js';
import { EnforcementService } from './enforcement.service.js';

/**
 * Enforcement: the ladder, admin actions, review cases and appeals (Backend PRD 21.4). No module
 * changes a user's status or restrictions except through EnforcementService.
 */
@Module({
  imports: [AuthModule, AuditModule, ConfigStoreModule, DatabaseModule, QueueModule, ErrandsModule, RatingsModule, ReliabilityModule, VerificationModule],
  controllers: [EnforcementController],
  providers: [EnforcementService, EnforcementEventHandler],
  exports: [EnforcementService],
})
export class EnforcementModule {}

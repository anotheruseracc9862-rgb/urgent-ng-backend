import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { EntitlementsModule } from '../entitlements/entitlements.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { BadgeEventHandler } from './badge.handler.js';
import { BadgeMetricsService } from './badge-metrics.service.js';
import { BadgeService } from './badge.service.js';
import { BadgesController } from './badges.controller.js';

/**
 * Earned, display-only badges (Backend PRD 21.5). Other modules read them through
 * `BadgeService.visibleFor`; nothing but BadgeService writes `user_badges`.
 */
@Module({
  imports: [AuthModule, AuditModule, ConfigStoreModule, DatabaseModule, QueueModule, EntitlementsModule, VerificationModule],
  controllers: [BadgesController],
  providers: [BadgeService, BadgeMetricsService, BadgeEventHandler],
  exports: [BadgeService],
})
export class BadgesModule {}

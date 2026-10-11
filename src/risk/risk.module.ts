import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { RiskEventHandler } from './risk-event.handler.js';
import { RiskFlagService } from './risk-flag.service.js';

/**
 * Risk flags (Backend PRD 21.6). Deliberately light on imports (no AuthModule), so the auth and
 * marketplace modules can raise signals without a cycle. The cursor service comes from the
 * global CommonModule.
 */
@Module({
  imports: [AuditModule, ConfigStoreModule, DatabaseModule, QueueModule],
  providers: [RiskFlagService, RiskEventHandler],
  exports: [RiskFlagService],
})
export class RiskModule {}

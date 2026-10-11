import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { ErrandsModule } from '../errands/errands.module.js';
import { ReliabilityModule } from '../reliability/reliability.module.js';
import { DisputesModule } from '../disputes/disputes.module.js';
import { EnforcementModule } from '../enforcement/enforcement.module.js';
import { ReportService } from './report.service.js';
import { ReportsController } from './reports.controller.js';

/** Reports: persistent complaint cases (Backend PRD 21.2). */
@Module({
  imports: [AuthModule, AuditModule, ConfigStoreModule, DatabaseModule, IdempotencyModule, QueueModule, ErrandsModule, ReliabilityModule, DisputesModule, EnforcementModule],
  controllers: [ReportsController],
  providers: [ReportService],
  exports: [ReportService],
})
export class ReportsModule {}

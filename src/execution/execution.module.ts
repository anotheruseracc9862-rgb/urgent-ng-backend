import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { MediaModule } from '../media/media.module.js';
import { ErrandsModule } from '../errands/errands.module.js';
import { AssignmentsModule } from '../assignments/assignments.module.js';
import { ExecutionController } from './execution.controller.js';
import { ExecutionService } from './execution.service.js';
import { ExecutionDetailsController } from './execution-details.controller.js';
import { ExecutionDetailsService } from './execution-details.service.js';
import { ExecutionMediaAccess } from './execution-media.access.js';

/** Execution of an accepted assignment (Backend PRD 15). */
@Module({
  imports: [AuthModule, AuditModule, ConfigStoreModule, DatabaseModule, IdempotencyModule, QueueModule, MediaModule, ErrandsModule, AssignmentsModule],
  controllers: [ExecutionController, ExecutionDetailsController],
  providers: [ExecutionService, ExecutionDetailsService, ExecutionMediaAccess],
  exports: [ExecutionService],
})
export class ExecutionModule {}

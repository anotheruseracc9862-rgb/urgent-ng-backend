import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { ErrandsModule } from '../errands/errands.module.js';
import { OffersModule } from '../offers/offers.module.js';
import { RunnerModule } from '../runner/runner.module.js';
import { AssignmentService } from './assignment.service.js';
import { AssignmentTransitionHandlerImpl } from './assignment-transition.handler.js';
import { AssignmentsController } from './assignments.controller.js';
import { PaymentAgreementController } from './payment-agreement.controller.js';
import { PaymentAgreementService } from './payment-agreement.service.js';
import { ChangeRequestController } from './change-request.controller.js';
import { ChangeRequestService } from './change-request.service.js';
import { ErrandDeletionBlocker } from './errand-deletion-blocker.js';
import { RunnerAssignmentsController } from './runner-assignments.controller.js';
import { RunnerAssignmentsService } from './runner-assignments.service.js';

/**
 * Assignments (Backend PRD 14). Imports ErrandsModule for the state machine; ErrandsModule must
 * never import this module (a cycle). Anything the errand module has to tell the assignment
 * goes through a hook token.
 */
@Module({
  imports: [AuthModule, AuditModule, ConfigStoreModule, DatabaseModule, IdempotencyModule, QueueModule, ErrandsModule, OffersModule, RunnerModule],
  controllers: [AssignmentsController, PaymentAgreementController, ChangeRequestController, RunnerAssignmentsController],
  providers: [AssignmentService, AssignmentTransitionHandlerImpl, PaymentAgreementService, ChangeRequestService, ErrandDeletionBlocker, RunnerAssignmentsService],
  exports: [AssignmentService, PaymentAgreementService, ChangeRequestService, ErrandDeletionBlocker, RunnerAssignmentsService],
})
export class AssignmentsModule {}

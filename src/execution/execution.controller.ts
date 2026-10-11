import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth, RequireNoRestriction } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { ExecutionService } from './execution.service.js';
import { ExecutionStepDto, StepEvidenceDto } from './execution.dto.js';

/**
 * Execution steps (Backend PRD 15, 30.6). A user who deactivated their account may still finish
 * an errand they already started, so these routes also allow DEACTIVATED (the enforcement
 * policy for suspended users arrives with P9-04).
 */
@ApiTags('Execution')
@Controller()
export class ExecutionController {
  constructor(private readonly execution: ExecutionService) {}

  @Post('assignments/:id/start')
  @Idempotent({ operation: 'execution-start' })
  @ConsumerAuth({ allow: ['DEACTIVATED'], continueWhenSuspended: true })
  @RequireNoRestriction('RUNNING')
  @ApiConsumerAuth()
  @ApiEnveloped(ExecutionStepDto, { status: 201 })
  @ApiErrors(403, 404, 409)
  start(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.execution.start(user.userId, id);
  }

  @Post('assignments/:id/pickup')
  @Idempotent({ operation: 'execution-pickup' })
  @ConsumerAuth({ allow: ['DEACTIVATED'], continueWhenSuspended: true })
  @RequireNoRestriction('RUNNING')
  @ApiConsumerAuth()
  @ApiEnveloped(ExecutionStepDto, { status: 201 })
  @ApiErrors(400, 403, 404, 409)
  pickup(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StepEvidenceDto) {
    return this.execution.pickup(user.userId, id, dto);
  }

  @Post('assignments/:id/deliver')
  @Idempotent({ operation: 'execution-deliver' })
  @ConsumerAuth({ allow: ['DEACTIVATED'], continueWhenSuspended: true })
  @RequireNoRestriction('RUNNING')
  @ApiConsumerAuth()
  @ApiEnveloped(ExecutionStepDto, { status: 201 })
  @ApiErrors(400, 403, 404, 409)
  deliver(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StepEvidenceDto) {
    return this.execution.deliver(user.userId, id, dto);
  }

  /** The requester confirms the errand was done. Completion never depends on payment. */
  @Post('errands/:id/complete')
  @Idempotent({ operation: 'errand-complete' })
  @ConsumerAuth({ allow: ['DEACTIVATED'], continueWhenSuspended: true })
  @ApiConsumerAuth()
  @ApiEnveloped(ExecutionStepDto, { status: 201 })
  @ApiErrors(404, 409)
  complete(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.execution.complete(user.userId, id);
  }
}

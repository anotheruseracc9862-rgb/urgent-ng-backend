import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth, RequireNoRestriction } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { AssignmentService } from './assignment.service.js';
import { AssignmentDetailDto, AssignmentDto, CancelAssignmentDto, SelectRunnerDto } from './assignment.dto.js';

/** Selection and assignments (Backend PRD 14, 30.5). */
@ApiTags('Assignments')
@Controller()
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentService) {}

  @Post('errands/:errandId/select-runner')
  @Idempotent({ operation: 'assignment-select' })
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(AssignmentDto, { status: 201 })
  @ApiErrors(400, 403, 404, 409)
  select(
    @CurrentUser() user: AuthenticatedUser,
    @Param('errandId', ParseUUIDPipe) errandId: string,
    @Body() dto: SelectRunnerDto,
  ) {
    return this.assignments.selectRunner(user.userId, errandId, dto);
  }

  /** The selected runner accepts within the acceptance window. */
  @Post('assignments/:id/accept')
  @Idempotent({ operation: 'assignment-accept' })
  @ConsumerAuth()
  @RequireNoRestriction('RUNNING')
  @ApiConsumerAuth()
  @ApiEnveloped(AssignmentDto, { status: 201 })
  @ApiErrors(403, 404, 409)
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assignments.accept(user.userId, id);
  }

  /** Cancel a live assignment. The result depends on the stage and on who cancels (PRD 11.7). */
  @Post('assignments/:id/cancel')
  @HttpCode(200)
  @Idempotent({ operation: 'assignment-cancel' })
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(AssignmentDto)
  @ApiErrors(400, 404, 409)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelAssignmentDto) {
    return this.assignments.cancel(user.userId, id, dto);
  }

  @Post('assignments/:id/decline')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(AssignmentDto)
  @ApiErrors(403, 404, 409)
  decline(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assignments.decline(user.userId, id);
  }

  @Get('assignments/:id')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(AssignmentDetailDto)
  @ApiErrors(404)
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assignments.getForParty(user.userId, id);
  }
}

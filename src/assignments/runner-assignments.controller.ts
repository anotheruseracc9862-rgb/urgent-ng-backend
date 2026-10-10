import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { RunnerAssignmentsService } from './runner-assignments.service.js';
import { RunnerAssignmentSummaryDto, RunnerAssignmentsQueryDto } from './runner-assignments.dto.js';

@ApiTags('Runner')
@Controller('runner/assignments')
export class RunnerAssignmentsController {
  constructor(private readonly assignments: RunnerAssignmentsService) {}

  /** The signed-in runner's assignments, newest first. */
  @Get()
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(RunnerAssignmentSummaryDto, { isArray: true })
  @ApiErrors(400)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: RunnerAssignmentsQueryDto) {
    return this.assignments.list(user.userId, query);
  }
}

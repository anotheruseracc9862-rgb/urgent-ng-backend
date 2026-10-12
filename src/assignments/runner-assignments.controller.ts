import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { NoEnvelope } from '../common/decorators/no-envelope.decorator.js';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { RunnerAssignmentsService } from './runner-assignments.service.js';
import {
  HistorySummaryDto,
  HistorySummaryQueryDto,
  RunnerAssignmentSummaryDto,
  RunnerAssignmentsQueryDto,
  RunnerHistoryExportQueryDto,
} from './runner-assignments.dto.js';

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

  /** Completed, cancelled and not-accepted counts per month, for the job-history chart. */
  @Get('summary')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(HistorySummaryDto)
  @ApiErrors(400)
  summary(@CurrentUser() user: AuthenticatedUser, @Query() query: HistorySummaryQueryDto) {
    return this.assignments.summary(user.userId, query.months);
  }

  /** The job history as a CSV file, with the same filters as the list. */
  @Get('export.csv')
  @NoEnvelope()
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The history as CSV.', content: { 'text/csv': { schema: { type: 'string' } } } })
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiErrors(400)
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RunnerHistoryExportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="job-history.csv"');
    return this.assignments.exportCsv(user.userId, query);
  }
}

import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { ReportService } from './report.service.js';
import { CreateReportDto, ReportDto, ReportListQueryDto, ReportRatingDto } from './report.dto.js';

/**
 * Reports (Backend PRD 21.2, 30.7). Any signed-in user can report; a suspended or deactivated
 * account still can, since a report is how a user raises a safety problem.
 */
@ApiTags('Reports')
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportService) {}

  @Post('reports')
  @Idempotent({ operation: 'report-create' })
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ReportDto, { status: 201 })
  @ApiErrors(400, 404, 429)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateReportDto) {
    return this.reports.create(user.userId, dto);
  }

  @Get('reports')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ReportDto, { isArray: true })
  @ApiErrors(400)
  mine(@CurrentUser() user: AuthenticatedUser, @Query() query: ReportListQueryDto) {
    return this.reports.listMine(user.userId, query);
  }

  @Get('reports/:id')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ReportDto)
  @ApiErrors(404)
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.get(user.userId, id);
  }

  /** Report a rating you received (Backend PRD 30.7). */
  @Post('ratings/:id/report')
  @Idempotent({ operation: 'report-rating' })
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ReportDto, { status: 201 })
  @ApiErrors(400, 404, 429)
  reportRating(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportRatingDto) {
    return this.reports.create(user.userId, { targetType: 'RATING', targetId: id, type: dto.type, description: dto.description });
  }
}

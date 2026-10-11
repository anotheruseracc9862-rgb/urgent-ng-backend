import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { ReliabilityService } from './reliability.service.js';
import { NoShowService } from './no-show.service.js';
import { NoShowReportDto, NoShowStateDto, ReportNoShowDto, RespondNoShowDto } from './no-show.dto.js';
import { ReliabilityExplanationDto } from './reliability.dto.js';

/** Reliability and no-show reports (Backend PRD 21.1, 30.6). */
@ApiTags('Reliability')
@Controller()
export class ReliabilityController {
  constructor(
    private readonly reliability: ReliabilityService,
    private readonly noShows: NoShowService,
  ) {}

  /** The caller's own points and every event behind them. A user can always see why. */
  @Get('me/reliability')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ReliabilityExplanationDto)
  explain(@CurrentUser() user: AuthenticatedUser) {
    return this.reliability.explain(user.userId);
  }

  @Get('assignments/:id/no-show')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(NoShowStateDto)
  @ApiErrors(404)
  state(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.noShows.state(user.userId, id);
  }

  @Post('assignments/:id/no-show')
  @Idempotent({ operation: 'no-show-report' })
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(NoShowReportDto, { status: 201 })
  @ApiErrors(400, 404, 409)
  report(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportNoShowDto) {
    return this.noShows.report(user.userId, id, dto);
  }

  @Post('assignments/:id/no-show/respond')
  @HttpCode(200)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(NoShowReportDto)
  @ApiErrors(400, 404)
  respond(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RespondNoShowDto) {
    return this.noShows.respond(user.userId, id, dto);
  }
}

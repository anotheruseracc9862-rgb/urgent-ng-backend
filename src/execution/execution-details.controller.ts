import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth, RequireNoRestriction } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { ExecutionDetailsService } from './execution-details.service.js';
import { DelayNoticeDto, ExecutionEventDto, ProblemDto, ReceiptDto, ReportProblemDto } from './execution-details.dto.js';

/** Problems, delay notices, receipts and the timeline (Backend PRD 15.4, 15.5, 30.6). */
@ApiTags('Execution')
@Controller('assignments/:id')
export class ExecutionDetailsController {
  constructor(private readonly details: ExecutionDetailsService) {}

  @Post('problems')
  @Idempotent({ operation: 'execution-problem' })
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @RequireNoRestriction('RUNNING')
  @ApiConsumerAuth()
  @ApiEnveloped(ProblemDto, { status: 201 })
  @ApiErrors(400, 404, 409)
  report(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportProblemDto) {
    return this.details.reportProblem(user.userId, id, dto);
  }

  @Get('problems')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ProblemDto, { isArray: true })
  @ApiErrors(404)
  problems(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.details.listProblems(user.userId, id);
  }

  @Post('problems/:problemId/resolve')
  @HttpCode(200)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ProblemDto)
  @ApiErrors(404, 409)
  resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('problemId', ParseUUIDPipe) problemId: string,
  ) {
    return this.details.resolveProblem(user.userId, id, problemId);
  }

  @Post('delay-notices')
  @Idempotent({ operation: 'execution-delay-notice' })
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @RequireNoRestriction('RUNNING')
  @ApiConsumerAuth()
  @ApiEnveloped(ExecutionEventDto, { status: 201 })
  @ApiErrors(400, 404, 409)
  delay(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DelayNoticeDto) {
    return this.details.delayNotice(user.userId, id, dto);
  }

  @Post('receipt')
  @Idempotent({ operation: 'execution-receipt' })
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @RequireNoRestriction('RUNNING')
  @ApiConsumerAuth()
  @ApiEnveloped(ExecutionEventDto, { status: 201 })
  @ApiErrors(400, 404, 409)
  receipt(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceiptDto) {
    return this.details.addReceipt(user.userId, id, dto);
  }

  @Get('timeline')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ExecutionEventDto, { isArray: true })
  @ApiErrors(404)
  timeline(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.details.timeline(user.userId, id);
  }
}

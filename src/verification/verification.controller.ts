import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { ReqCtx } from '../auth/decorators/request-context.decorator.js';
import type { RequestContext } from '../auth/auth-audit.service.js';
import { VerificationService } from './verification.service.js';
import { StartVerificationDto, VerificationAttemptDto, VerificationOverviewDto } from './verification.dto.js';

/** Runner identity verification (Backend PRD 30.2). */
@ApiTags('Verification')
@Controller('verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get()
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(VerificationOverviewDto)
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.verification.overview(user.userId);
  }

  /**
   * Run a verification attempt. Needs an `Idempotency-Key`. The answer is the finished attempt:
   * check `status` (`VERIFIED` or `FAILED`) and `failureReason`.
   */
  @Post('attempts')
  @Idempotent({ operation: 'verification-attempt' })
  @RateLimit('auth')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(VerificationAttemptDto, { status: 201 })
  @ApiErrors(400, 402, 403, 409, 429)
  start(@CurrentUser() user: AuthenticatedUser, @Body() dto: StartVerificationDto, @ReqCtx() ctx: RequestContext) {
    return this.verification.startAttempt(user.userId, dto, ctx);
  }

  @Get('attempts/:id')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(VerificationAttemptDto)
  @ApiErrors(400, 404)
  attempt(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.verification.getAttempt(user.userId, id);
  }
}

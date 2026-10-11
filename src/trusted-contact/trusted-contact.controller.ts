import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import { TrustedContactService } from './trusted-contact.service.js';
import { ConcernResultDto, CreatedShareDto, RaiseConcernDto, SharedErrandDto, ShareDto } from './trusted-contact.dto.js';

/** Links made by the requester or the assigned runner (Backend PRD 17.5, 30.4). */
@ApiTags('Trusted contact')
@Controller()
export class TrustedContactController {
  constructor(private readonly shares: TrustedContactService) {}

  @Post('errands/:id/trusted-contact')
  @Idempotent({ operation: 'trusted-contact-create' })
  @ConsumerAuth({ allow: ['DEACTIVATED'], continueWhenSuspended: true })
  @ApiConsumerAuth()
  @ApiEnveloped(CreatedShareDto, { status: 201 })
  @ApiErrors(404, 409)
  create(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.shares.create(user.userId, id);
  }

  @Get('errands/:id/trusted-contact')
  @ConsumerAuth({ allow: ['DEACTIVATED'], continueWhenSuspended: true })
  @ApiConsumerAuth()
  @ApiEnveloped(ShareDto, { isArray: true })
  @ApiErrors(404)
  list(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.shares.list(user.userId, id);
  }

  @Delete('trusted-contact/:id')
  @ConsumerAuth({ allow: ['DEACTIVATED'], continueWhenSuspended: true })
  @ApiConsumerAuth()
  @ApiEnveloped(ShareDto)
  @ApiErrors(404)
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.shares.revoke(user.userId, id);
  }
}

/**
 * The public side: no account, rate limited per address (and per link), never indexed. A link
 * that is unknown, expired or revoked is "not found" without telling which.
 */
@ApiTags('Trusted contact')
@Controller('shared')
export class SharedLinkController {
  constructor(private readonly shares: TrustedContactService) {}

  @Get(':token')
  @RateLimit('public-token')
  @ApiEnveloped(SharedErrandDto)
  @ApiErrors(404, 429)
  async view(@Param('token') token: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    return this.shares.publicView(token);
  }

  @Post(':token/concern')
  @HttpCode(200)
  @RateLimit('public-token')
  @ApiEnveloped(ConcernResultDto)
  @ApiErrors(400, 404, 429)
  async concern(@Param('token') token: string, @Body() dto: RaiseConcernDto, @Res({ passthrough: true }) res: Response) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    return this.shares.raiseConcern(token, dto.message);
  }
}

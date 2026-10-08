import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { RequiresFlag } from '../common/decorators/requires-flag.decorator.js';
import { ConsumerAuth, RequireNoRestriction } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { ErrandService } from './errand.service.js';
import { ErrandLifecycleService } from './errand-lifecycle.service.js';
import { ErrandQueryService } from './errand-query.service.js';
import { CancelErrandDto, CreateErrandDto, ErrandDto, ErrandSummaryDto, MineQueryDto, PublishErrandDto, UpdateErrandDto } from './errand.dto.js';

/** The requester's side of errands (Backend PRD 30.4). The marketplace views are in MarketplaceController. */
@ApiTags('Errands')
@Controller('errands')
export class ErrandsController {
  constructor(
    private readonly errands: ErrandService,
    private readonly lifecycle: ErrandLifecycleService,
    private readonly query: ErrandQueryService,
  ) {}

  /** Create a draft. A draft may be incomplete. */
  @Post()
  @ConsumerAuth()
  @RequireNoRestriction('POSTING')
  @RequiresFlag('FEATURE_ERRAND_POSTING_ENABLED')
  @ApiConsumerAuth()
  @ApiEnveloped(ErrandDto, { status: 201 })
  @ApiErrors(400, 422)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateErrandDto) {
    return this.errands.create(user.userId, dto);
  }

  /** Your errands, newest first, for the dashboard tabs. */
  @Get('mine')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ErrandSummaryDto, { isArray: true })
  @ApiErrors(400)
  mine(@CurrentUser() user: AuthenticatedUser, @Query() query: MineQueryDto) {
    return this.query.mine(user.userId, query);
  }

  @Get(':id')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ErrandDto)
  @ApiErrors(400, 404)
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.errands.getOwned(user.userId, id);
  }

  /**
   * Edit a draft or an open errand. On an open errand a material change (locations, category,
   * time, item size or value) flags every offer for reconfirmation. After a runner is selected the
   * errand cannot be edited here.
   */
  @Patch(':id')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(ErrandDto)
  @ApiErrors(400, 404, 409, 422)
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateErrandDto) {
    return this.errands.update(user.userId, id, dto);
  }

  /** Publish a draft. Needs an `Idempotency-Key`: sending the same request twice creates one open errand. */
  @Post(':id/publish')
  @Idempotent({ operation: 'errand-publish' })
  @ConsumerAuth()
  @RequireNoRestriction('POSTING')
  @RequiresFlag('FEATURE_ERRAND_POSTING_ENABLED')
  @ApiConsumerAuth()
  @ApiEnveloped(ErrandDto, { status: 201 })
  @ApiErrors(400, 403, 404, 409, 422)
  publish(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PublishErrandDto) {
    return this.errands.publish(user, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(ErrandDto)
  @ApiErrors(400, 403, 404, 409)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelErrandDto) {
    return this.lifecycle.cancel(user.userId, id, dto);
  }

  /** Extend an open errand once before it expires. */
  @Post(':id/extend')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(ErrandDto)
  @ApiErrors(404, 409, 422)
  extend(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.lifecycle.extend(user.userId, id);
  }

  /** Copy an errand into a new draft. */
  @Post(':id/duplicate')
  @ConsumerAuth()
  @RequireNoRestriction('POSTING')
  @ApiConsumerAuth()
  @ApiEnveloped(ErrandDto, { status: 201 })
  @ApiErrors(404, 422)
  duplicate(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.lifecycle.duplicate(user.userId, id);
  }
}

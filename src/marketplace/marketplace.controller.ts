import { ApiTags } from '@nestjs/swagger';
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { MarketplaceFeedService } from './marketplace-feed.service.js';
import { SavedErrandsService } from './saved-errands.service.js';
import { FeedItemDto, FeedQueryDto, MapPointDto, MapQueryDto, MarketplaceErrandDto, SavedErrandItemDto, SavedStateDto } from './marketplace.dto.js';
import { PaginationQueryDto } from '../common/pagination/pagination.dto.js';

/**
 * The runner's view of open errands (Backend PRD 12, 30.4). Only verified, available, unrestricted
 * runners get in; each response is approximate by construction.
 */
@ApiTags('Marketplace')
@Controller('marketplace/errands')
export class MarketplaceController {
  constructor(private readonly feed: MarketplaceFeedService) {}

  /** Open errands inside your operating area, nearest or newest first. */
  @Get()
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(FeedItemDto, { isArray: true })
  @ApiErrors(400, 403, 429)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: FeedQueryDto) {
    return this.feed.feed(user.userId, query);
  }

  /** The same errands as map points, with approximate positions only. */
  @Get('map')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(MapPointDto, { isArray: true })
  @ApiErrors(400, 403, 429)
  map(@CurrentUser() user: AuthenticatedUser, @Query() query: MapQueryDto) {
    return this.feed.map(user.userId, query);
  }

  @Get(':id')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(MarketplaceErrandDto)
  @ApiErrors(400, 403, 404, 429)
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.feed.detail(user.userId, id);
  }
}

@ApiTags('Marketplace')
@Controller('saved-errands')
export class SavedErrandsController {
  constructor(private readonly saved: SavedErrandsService) {}

  @Get()
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(SavedErrandItemDto, { isArray: true })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.saved.list(user.userId, query);
  }

  /** Save an open errand. Saving it again changes nothing. */
  @Post(':errandId')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(SavedStateDto)
  @ApiErrors(400, 403, 404)
  save(@CurrentUser() user: AuthenticatedUser, @Param('errandId', ParseUUIDPipe) errandId: string) {
    return this.saved.save(user.userId, errandId);
  }

  /** Remove a saved errand. Removing one that is not saved changes nothing. */
  @Delete(':errandId')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(SavedStateDto)
  @ApiErrors(400)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('errandId', ParseUUIDPipe) errandId: string) {
    return this.saved.remove(user.userId, errandId);
  }
}

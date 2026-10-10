import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { RequiresFlag } from '../common/decorators/requires-flag.decorator.js';
import { OfferService } from './offer.service.js';
import { OfferListService } from './offer-list.service.js';
import { CounterOfferDto, OfferDto, OfferVersionDto, SubmitOfferDto } from './offer.dto.js';
import { OfferListItemDto, OfferListQueryDto } from './offer-list.dto.js';

/**
 * Offers and negotiation (Backend PRD 13, 30.5). The controller only identifies the caller and
 * calls the service: parties, errand state and turn rules are decided there, from the database.
 */
@ApiTags('Offers')
@Controller()
export class OffersController {
  constructor(
    private readonly offers: OfferService,
    private readonly offerList: OfferListService,
  ) {}

  @Post('errands/:errandId/offers')
  @RequiresFlag('FEATURE_OFFERS_ENABLED')
  @Idempotent({ operation: 'offer-submit' })
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto, { status: 201 })
  @ApiErrors(400, 403, 404, 409, 429)
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('errandId', ParseUUIDPipe) errandId: string,
    @Body() dto: SubmitOfferDto,
  ) {
    return this.offers.submitOffer({
      errandId,
      runnerId: user.userId,
      amountMinor: dto.amountMinor,
      durationMinutes: dto.durationMinutes,
      availabilityConfirmed: dto.availabilityConfirmed,
      message: dto.message,
    });
  }

  @Get('errands/:errandId/offers')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferListItemDto, { isArray: true })
  @ApiErrors(400, 404)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('errandId', ParseUUIDPipe) errandId: string,
    @Query() query: OfferListQueryDto,
  ): Promise<OfferListItemDto[]> {
    return this.offerList.getOffersForErrand(user.userId, errandId, query.sort);
  }

  /** The runner revises their own offer while it waits on the requester. */
  @Patch('offers/:id')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto)
  @ApiErrors(400, 403, 404, 409)
  edit(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CounterOfferDto) {
    return this.offers.edit(id, user.userId, dto);
  }

  @Post('offers/:id/counter')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto)
  @ApiErrors(400, 404, 409)
  counter(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CounterOfferDto) {
    return this.offers.counterOffer(id, user.userId, dto);
  }

  @Post('offers/:id/accept-counter')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto)
  @ApiErrors(403, 404, 409)
  acceptCounter(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OfferVersionDto) {
    return this.offers.acceptCounter(id, user.userId, dto.expectedVersion);
  }

  @Post('offers/:id/withdraw')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto)
  @ApiErrors(403, 404, 409)
  withdraw(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.offers.withdraw(id, user.userId);
  }

  @Post('offers/:id/reject')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto)
  @ApiErrors(403, 404, 409)
  reject(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OfferVersionDto) {
    return this.offers.rejectOffer(id, user.userId, dto.expectedVersion);
  }

  @Post('offers/:id/reconfirm')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto)
  @ApiErrors(403, 404, 409)
  reconfirm(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OfferVersionDto) {
    return this.offers.reconfirmOffer(id, user.userId, dto.expectedVersion);
  }
}

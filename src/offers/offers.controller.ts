import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { FORBIDDEN } from '../common/constants/error-codes.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { OfferService } from './offer.service.js';
import { CounterOfferDto, OfferDto, ReconfirmOfferDto, SubmitOfferDto } from './offer.dto.js';

@ApiTags('Offers')
@Controller()
export class OffersController {
  constructor(private readonly offers: OfferService) {}

  @Post('errands/:errandId/offers')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto, { status: 201 })
  @ApiErrors(400, 403, 404, 409, 422)
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('errandId', ParseUUIDPipe) errandId: string,
    @Body() dto: SubmitOfferDto,
  ) {
    return this.offers.submitOffer({
      errand: {
        id: errandId,
        requesterId: dto.requesterId,
        status: dto.status ?? 'OPEN',
      },
      runnerId: user.userId,
      amountMinor: dto.amountMinor,
      durationMinutes: dto.durationMinutes,
      availabilityConfirmedAt: dto.availabilityConfirmedAt,
      message: dto.message,
    });
  }

  @Get('errands/:errandId/offers')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto, { isArray: true })
  @ApiErrors(400, 403, 404)
  list(@Param('errandId', ParseUUIDPipe) errandId: string) {
    return this.offers.getLiveOffersForErrand(errandId);
  }

  @Patch('offers/:id')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto)
  @ApiErrors(400, 403, 404, 409)
  patch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CounterOfferDto,
  ) {
    const actor = this.resolveActor(user.userId, id);
    return this.offers.counterOffer(id, actor, dto.amountMinor, dto.durationMinutes, dto.message, dto.expectedVersion);
  }

  @Post('offers/:id/withdraw')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto)
  @ApiErrors(400, 403, 404)
  withdraw(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.offers.withdraw(id, user.userId);
  }

  @Post('offers/:id/counter')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto)
  @ApiErrors(400, 403, 404, 409)
  counter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CounterOfferDto,
  ) {
    const actor = this.resolveActor(user.userId, id);
    return this.offers.counterOffer(id, actor, dto.amountMinor, dto.durationMinutes, dto.message, dto.expectedVersion);
  }

  @Post('offers/:id/reject')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto)
  @ApiErrors(400, 403, 404, 409)
  reject(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    const actor = this.resolveActor(user.userId, id);
    return this.offers.rejectOffer(id, actor);
  }

  @Post('offers/:id/reconfirm')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OfferDto)
  @ApiErrors(400, 403, 404, 409)
  reconfirm(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReconfirmOfferDto) {
    return this.offers.reconfirmOffer(id, dto.expectedVersion, user.userId);
  }

  private resolveActor(userId: string, offerId: string): 'RUNNER' | 'REQUESTER' {
    const offer = this.offers.getOffer(offerId);
    if (!offer) {
      throw DomainException.of(FORBIDDEN, {
        message: 'Offer not found or the user is not a party to it.',
        details: { offerId, userId },
      });
    }
    if (offer.runnerId === userId) {
      return 'RUNNER';
    }
    if (offer.requesterId === userId) {
      return 'REQUESTER';
    }
    throw DomainException.of(FORBIDDEN, {
      message: 'You are not a party to this offer.',
      details: { offerId, userId, runnerId: offer.runnerId, requesterId: offer.requesterId },
    });
  }
}

import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { RequesterOffersService } from './requester-offers.service.js';
import { RequesterOfferSummaryDto, RequesterOffersQueryDto } from './requester-offers.dto.js';

@ApiTags('Offers')
@Controller('requester/offers')
export class RequesterOffersController {
  constructor(private readonly offers: RequesterOffersService) {}

  /** Every offer on the signed-in requester's errands, newest first. */
  @Get()
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(RequesterOfferSummaryDto, { isArray: true })
  @ApiErrors(400)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: RequesterOffersQueryDto) {
    return this.offers.list(user.userId, query);
  }
}

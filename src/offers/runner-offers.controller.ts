import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { RunnerOffersService } from './runner-offers.service.js';
import { RunnerOfferSummaryDto, RunnerOffersQueryDto } from './runner-offers.dto.js';

@ApiTags('Runner')
@Controller('runner/offers')
export class RunnerOffersController {
  constructor(private readonly offers: RunnerOffersService) {}

  /** Every offer the signed-in runner made, newest first. */
  @Get()
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(RunnerOfferSummaryDto, { isArray: true })
  @ApiErrors(400)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: RunnerOffersQueryDto) {
    return this.offers.list(user.userId, query);
  }
}

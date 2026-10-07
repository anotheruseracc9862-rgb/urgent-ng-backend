import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { RunnerProfileService } from './runner-profile.service.js';
import { RunnerEligibilityService } from './runner-eligibility.service.js';
import { RunnerEligibilityDto, RunnerProfileDto, UpdateAvailabilityDto, UpdateRunnerProfileDto } from './runner.dto.js';

/** Runner profile, availability and eligibility (Backend PRD 30.2). */
@ApiTags('Runner')
@Controller('runner')
export class RunnerController {
  constructor(
    private readonly profile: RunnerProfileService,
    private readonly eligibility: RunnerEligibilityService,
  ) {}

  @Get('profile')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(RunnerProfileDto)
  @ApiErrors(404)
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.profile.get(user.userId);
  }

  /** Create or replace the profile. Does not change availability. */
  @Put('profile')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(RunnerProfileDto)
  @ApiErrors(400)
  put(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateRunnerProfileDto) {
    return this.profile.upsert(user.userId, dto);
  }

  @Put('availability')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(RunnerProfileDto)
  @ApiErrors(400, 409)
  availability(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateAvailabilityDto) {
    return this.profile.setAvailability(user.userId, dto.availability);
  }

  /** Whether the runner may browse the feed and submit offers right now, and why not. */
  @Get('eligibility')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(RunnerEligibilityDto)
  async getEligibility(@CurrentUser() user: AuthenticatedUser) {
    const [offer, feed] = await Promise.all([
      this.eligibility.canOffer(user.userId),
      this.eligibility.canBrowseFeed(user.userId),
    ]);
    return { canOffer: offer.allowed, canBrowseFeed: feed.allowed, reasons: offer.reasons };
  }
}

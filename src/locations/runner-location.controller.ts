import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import { RunnerLocationService } from './runner-location.service.js';
import { LiveLocationDto, RecordedLocationDto, ReportLocationDto, SharingDto, SharingStateDto } from './runner-location.dto.js';

/** Runner location sharing and the live view (Backend PRD 17.3, 17.4, 30.6). */
@ApiTags('Location')
@Controller('assignments/:id/location')
export class RunnerLocationController {
  constructor(private readonly locations: RunnerLocationService) {}

  @Post()
  @HttpCode(200)
  @RateLimit('location')
  @ConsumerAuth({ allow: ['DEACTIVATED'], continueWhenSuspended: true })
  @ApiConsumerAuth()
  @ApiEnveloped(RecordedLocationDto)
  @ApiErrors(400, 403, 404, 409, 429)
  report(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportLocationDto) {
    return this.locations.record(user.userId, id, dto);
  }

  @Put('sharing')
  @ConsumerAuth({ allow: ['DEACTIVATED'], continueWhenSuspended: true })
  @ApiConsumerAuth()
  @ApiEnveloped(SharingStateDto)
  @ApiErrors(400, 404)
  setSharing(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SharingDto) {
    return this.locations.setSharing(user.userId, id, dto.enabled);
  }

  @Get()
  @ConsumerAuth({ allow: ['DEACTIVATED'], continueWhenSuspended: true })
  @ApiConsumerAuth()
  @ApiEnveloped(LiveLocationDto)
  @ApiErrors(404)
  live(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.locations.liveFor(user.userId, id);
  }
}

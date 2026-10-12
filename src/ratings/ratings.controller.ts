import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { RatingService } from './rating.service.js';
import {
  AssignmentRatingsDto,
  EditRatingDto,
  MyRatingDto,
  MyRatingsQueryDto,
  ProfileRatingDto,
  RatingDto,
  RatingListQueryDto,
  SubmitRatingDto,
} from './ratings.dto.js';

/**
 * Ratings (Backend PRD 20, 30.7). Only the two parties of a completed assignment rate each other.
 * A DEACTIVATED account may still rate, like it may still finish an errand.
 */
@ApiTags('Ratings')
@Controller()
export class RatingsController {
  constructor(private readonly ratings: RatingService) {}

  @Post('assignments/:id/ratings')
  @Idempotent({ operation: 'rating-submit' })
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(RatingDto, { status: 201 })
  @ApiErrors(400, 403, 404, 409)
  submit(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitRatingDto) {
    return this.ratings.submit(user.userId, id, dto);
  }

  @Get('assignments/:id/ratings')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(AssignmentRatingsDto)
  @ApiErrors(404)
  forAssignment(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ratings.forAssignment(user.userId, id);
  }

  @Patch('ratings/:id')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(RatingDto)
  @ApiErrors(400, 403, 404)
  edit(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EditRatingDto) {
    return this.ratings.edit(user.userId, id, dto);
  }

  /** The reviews page: ratings you received, or the ones you gave. */
  @Get('me/ratings')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] })
  @ApiConsumerAuth()
  @ApiEnveloped(MyRatingDto, { isArray: true })
  @ApiErrors(400)
  mine(@CurrentUser() user: AuthenticatedUser, @Query() query: MyRatingsQueryDto) {
    return this.ratings.listMine(user.userId, query);
  }

  @Get('users/:id/ratings')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ProfileRatingDto, { isArray: true })
  @ApiErrors(400, 404)
  listForUser(@Param('id', ParseUUIDPipe) id: string, @Query() query: RatingListQueryDto) {
    return this.ratings.listForUser(id, query);
  }
}

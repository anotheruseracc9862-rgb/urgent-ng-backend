import { ApiTags, ApiProperty } from '@nestjs/swagger';
import { Controller, Get } from '@nestjs/common';
import { ApiEnveloped, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { BadgeService } from './badge.service.js';

class RatingFigureDto {
  @ApiProperty()
  count!: number;
  @ApiProperty({ nullable: true, type: Number, description: 'Null until there are enough published ratings.' })
  average!: number | null;
}

class CancellationFigureDto {
  @ApiProperty({ description: 'How many accepted errands the figure looks at at most (TRUSTED_CANCELLATION_WINDOW).' })
  windowSize!: number;
  @ApiProperty({ description: 'How many accepted errands it actually looked at.' })
  sample!: number;
  @ApiProperty({ nullable: true, type: Number, description: 'Percent of those you cancelled.' })
  percent!: number | null;
}

class ResponseFigureDto {
  @ApiProperty()
  windowSize!: number;
  @ApiProperty()
  sample!: number;
  @ApiProperty({ nullable: true, type: Number, description: 'Median minutes to your first reply. Null without a sample.' })
  medianMinutes!: number | null;
}

export class RunnerPerformanceDto {
  @ApiProperty()
  completedErrands!: number;
  @ApiProperty({ type: RatingFigureDto })
  rating!: RatingFigureDto;
  @ApiProperty({ type: CancellationFigureDto })
  cancellation!: CancellationFigureDto;
  @ApiProperty({ type: ResponseFigureDto })
  response!: ResponseFigureDto;
  @ApiProperty({ type: String, isArray: true, description: 'Badges shown beside your name, strongest first.' })
  badges!: string[];
}

/** Runner performance (Backend PRD 30.2): the figures behind the badges, computed from source rows. */
@ApiTags('Runner')
@Controller()
export class BadgesController {
  constructor(private readonly badges: BadgeService) {}

  @Get('runner/performance')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(RunnerPerformanceDto)
  performance(@CurrentUser() user: AuthenticatedUser) {
    return this.badges.performance(user.userId);
  }
}

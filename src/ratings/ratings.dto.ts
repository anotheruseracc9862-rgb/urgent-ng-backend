import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination/pagination.dto.js';

export const RATING_DIMENSIONS = ['OVERALL', 'RELIABILITY', 'COMMUNICATION', 'TIMELINESS', 'PAYMENT_CONDUCT'] as const;
export type RatingDimensionName = (typeof RATING_DIMENSIONS)[number];

export const RATING_REVIEW_MAX_LENGTH = 1000;

/** Each score is 1 to 5 (Backend PRD 20.2). `overall` is required on a new rating. */
export class RatingScoresDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  overall?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  reliability?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  communication?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  timeliness?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  paymentConduct?: number;
}

export class SubmitRatingDto {
  @ApiProperty({ type: RatingScoresDto })
  @IsObject()
  @ValidateNested()
  @Type(() => RatingScoresDto)
  scores!: RatingScoresDto;

  @ApiPropertyOptional({ maxLength: RATING_REVIEW_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(RATING_REVIEW_MAX_LENGTH)
  review?: string;
}

/** A rating can be edited until it is revealed or the edit window closes. */
export class EditRatingDto {
  @ApiPropertyOptional({ type: RatingScoresDto, description: 'Scores sent replace the matching dimensions; a dimension left out keeps its score.' })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RatingScoresDto)
  scores?: RatingScoresDto;

  @ApiPropertyOptional({ maxLength: RATING_REVIEW_MAX_LENGTH, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(RATING_REVIEW_MAX_LENGTH)
  review?: string;
}

export class RatingListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Only ratings whose overall score is at least this.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  minStars?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Only ratings whose overall score is at most this. 3 gives "3 stars and below".' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  maxStars?: number;
}

export const MY_RATING_DIRECTIONS = ['RECEIVED', 'GIVEN'] as const;

export class MyRatingsQueryDto extends RatingListQueryDto {
  @ApiPropertyOptional({
    enum: MY_RATING_DIRECTIONS,
    default: 'RECEIVED',
    description: 'RECEIVED: ratings others gave you (published only). GIVEN: ratings you gave, including ones not revealed yet.',
  })
  @IsOptional()
  @IsIn(MY_RATING_DIRECTIONS as unknown as string[])
  direction?: (typeof MY_RATING_DIRECTIONS)[number];
}

export class RatingScoresViewDto {
  @ApiProperty({ nullable: true, type: Number })
  overall!: number | null;
  @ApiProperty({ nullable: true, type: Number })
  reliability!: number | null;
  @ApiProperty({ nullable: true, type: Number })
  communication!: number | null;
  @ApiProperty({ nullable: true, type: Number })
  timeliness!: number | null;
  @ApiProperty({ nullable: true, type: Number })
  paymentConduct!: number | null;
}

/** A rating as its rater sees it, and as the ratee sees it once revealed. */
export class RatingDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  assignmentId!: string;
  @ApiProperty({ enum: ['REQUESTER_TO_RUNNER', 'RUNNER_TO_REQUESTER'] })
  direction!: string;
  @ApiProperty({ type: RatingScoresViewDto })
  scores!: RatingScoresViewDto;
  @ApiProperty({ nullable: true, type: String })
  review!: string | null;
  @ApiProperty({ enum: ['PUBLISHED', 'HIDDEN', 'REMOVED', 'UNDER_REVIEW'] })
  status!: string;
  @ApiProperty({ description: 'True once both sides rated or the rating window closed.' })
  revealed!: boolean;
  @ApiProperty({ description: 'True while the rater can still change it.' })
  editable!: boolean;
  @ApiProperty({ type: Date, nullable: true })
  editableUntil!: Date | null;
  @ApiProperty({ type: Date })
  createdAt!: Date;
}

export class AssignmentRatingsDto {
  @ApiProperty({ description: 'The caller may submit a rating now.' })
  canRate!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Why not, when canRate is false: NOT_COMPLETED, WINDOW_CLOSED or ALREADY_RATED.' })
  reason!: string | null;
  @ApiProperty({ type: Date, nullable: true, description: 'When the rating window closes (null until the errand completes).' })
  windowEndsAt!: Date | null;
  @ApiProperty({ type: RatingDto, nullable: true })
  mine!: RatingDto | null;
  @ApiProperty({ type: RatingDto, nullable: true, description: 'The other side rating, only after the blind reveal.' })
  theirs!: RatingDto | null;
  @ApiProperty({ description: 'The other side has rated. Their content stays hidden until the reveal.' })
  counterpartRated!: boolean;
}

/** A published rating on someone's profile. The rater is shown by first name and last initial. */
export class ProfileRatingDto {
  @ApiProperty()
  id!: string;
  @ApiProperty({ enum: ['REQUESTER_TO_RUNNER', 'RUNNER_TO_REQUESTER'] })
  direction!: string;
  @ApiProperty({ type: RatingScoresViewDto })
  scores!: RatingScoresViewDto;
  @ApiProperty({ nullable: true, type: String })
  review!: string | null;
  @ApiProperty()
  raterFirstName!: string;
  @ApiProperty()
  raterLastInitial!: string;
  @ApiProperty({ type: Date })
  createdAt!: Date;
}

/** One rating on the signed-in user's reviews page, received or given. */
export class MyRatingDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  assignmentId!: string;
  @ApiProperty()
  errandTitle!: string;
  @ApiProperty({ enum: ['REQUESTER_TO_RUNNER', 'RUNNER_TO_REQUESTER'] })
  direction!: string;
  @ApiProperty({ type: RatingScoresViewDto })
  scores!: RatingScoresViewDto;
  @ApiProperty({ nullable: true, type: String })
  review!: string | null;
  @ApiProperty({ description: 'True once the rating is visible to the other side.' })
  revealed!: boolean;
  @ApiProperty({ description: 'The other person: the rater for a received rating, the ratee for a given one.' })
  counterpartFirstName!: string;
  @ApiProperty()
  counterpartLastInitial!: string;
  @ApiProperty({ type: Date })
  createdAt!: Date;
}

/** One side of a user's rating summary. `average` is null until there are enough published ratings. */
export class RatingSummaryDto {
  @ApiProperty()
  count!: number;
  @ApiProperty({ nullable: true, type: Number })
  average!: number | null;
}

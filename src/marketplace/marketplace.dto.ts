import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ErrandPriority, ErrandStatus, ItemSize, TimeMode } from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination/pagination.dto.js';
import { LatLngDto } from '../runner/runner.dto.js';
import { ErrandPhotoDto } from '../errands/errand.dto.js';

/**
 * `nearest` (default), `newest`, `recommended` (closest area first, newest within each 2 km ring)
 * and `budget_desc` (largest suggested budget first).
 */
export const FEED_SORTS = ['nearest', 'newest', 'recommended', 'budget_desc'] as const;
export type FeedSort = (typeof FEED_SORTS)[number];

/** Filters shared by the feed and the map (Backend PRD 12.3). */
export class MarketplaceFilterDto {
  /** Category keys, comma separated: `delivery,pickup`. */
  @ApiPropertyOptional({ example: 'delivery,pickup' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((key: string) => key.trim()).filter(Boolean) : value))
  @IsString({ each: true })
  category?: string[];

  /** Lowest suggested budget, kobo. Errands with no budget are left out when a budget bound is given. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  budgetMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  budgetMax?: number;

  @ApiPropertyOptional({ enum: TimeMode, enumName: 'TimeMode' })
  @IsOptional()
  @IsEnum(TimeMode)
  timeMode?: TimeMode;

  /** Narrow the search inside your operating area. Cannot widen it. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(20)
  radiusKm?: number;

  /** Free text over title, description, category and area. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class FeedQueryDto extends MarketplaceFilterDto implements PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor for pagination' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: FEED_SORTS, default: 'nearest' })
  @IsOptional()
  @IsEnum(FEED_SORTS)
  sort?: FeedSort = 'nearest';
}

export class MapQueryDto extends MarketplaceFilterDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 100;
}

export class PublicAreaDto {
  area!: string;
  @ApiProperty({ nullable: true, type: String })
  lga!: string | null;
  @ApiProperty({ nullable: true, type: String })
  state!: string | null;
}

export class DistanceBucketDto {
  /** The distance is below this many km. */
  upperKm!: number;
  /** For example "< 2.5 km". */
  label!: string;
}

export class FeedCategoryDto {
  key!: string;
  name!: string;
}

export class RequesterSummaryDto {
  firstName!: string;
  /** A media id. Fetch the picture with `GET /media/:id/url`. */
  @ApiProperty({ nullable: true, type: String })
  photoMediaId!: string | null;
  /** Average rating, once the requester has enough published ratings (RATING_MIN_COUNT_FOR_AVERAGE). */
  @ApiProperty({ nullable: true, type: Number })
  rating!: number | null;
  ratingCount!: number;
  @ApiProperty({ type: String, isArray: true, description: 'Earned requester badges, strongest first.' })
  badges!: string[];
}

/** One entry of the feed. Never carries an exact address, coordinates or a contact (Backend PRD 12.2). */
export class FeedItemDto {
  id!: string;
  title!: string;
  @ApiProperty({ type: FeedCategoryDto })
  category!: FeedCategoryDto;
  description!: string;
  @ApiProperty({ type: PublicAreaDto, nullable: true })
  pickup!: PublicAreaDto | null;
  @ApiProperty({ type: PublicAreaDto, nullable: true })
  destination!: PublicAreaDto | null;
  /** From the centre of your operating area, rounded into a bucket. Null when you have no operating area. */
  @ApiProperty({ type: DistanceBucketDto, nullable: true })
  distance!: DistanceBucketDto | null;
  @ApiProperty({ enum: TimeMode, enumName: 'TimeMode' })
  timeMode!: TimeMode;
  @ApiProperty({ enum: ErrandPriority, enumName: 'ErrandPriority' })
  priority!: ErrandPriority;
  @ApiProperty({ nullable: true, type: Date })
  scheduledAt!: Date | null;
  @ApiProperty({ nullable: true, type: Number })
  suggestedBudgetMinor!: number | null;
  @ApiProperty({ type: RequesterSummaryDto })
  requester!: RequesterSummaryDto;
  postedAt!: Date;
  expiresAt!: Date;
  offerCount!: number;
  /** A boosted errand is pinned above the normal results (Backend PRD 12.4). */
  boosted!: boolean;
  saved!: boolean;
}

export class MapPointDto {
  id!: string;
  title!: string;
  categoryKey!: string;
  area!: string;
  /** The approximate point (about 500 m grid plus a private offset). */
  @ApiProperty({ type: LatLngDto })
  approx!: LatLngDto;
  @ApiProperty({ enum: ErrandPriority, enumName: 'ErrandPriority' })
  priority!: ErrandPriority;
  @ApiProperty({ nullable: true, type: Number })
  suggestedBudgetMinor!: number | null;
  @ApiProperty({ type: DistanceBucketDto })
  distance!: DistanceBucketDto;
  boosted!: boolean;
}

export class PublicLocationViewDto extends PublicAreaDto {
  @ApiProperty({ type: LatLngDto })
  approx!: LatLngDto;
}

/** An open errand as another user sees it (approximate view). */
export class MarketplaceErrandDto extends FeedItemDto {
  @ApiProperty({ nullable: true, type: String })
  instructions!: string | null;
  @ApiProperty({ enum: ItemSize, enumName: 'ItemSize', nullable: true })
  itemSize!: ItemSize | null;
  @ApiProperty({ nullable: true, type: Number })
  itemValueMinor!: number | null;
  @ApiProperty({ type: PublicLocationViewDto, nullable: true })
  pickupApprox!: PublicLocationViewDto | null;
  @ApiProperty({ type: PublicLocationViewDto, nullable: true })
  destinationApprox!: PublicLocationViewDto | null;
  @ApiProperty({ type: [ErrandPhotoDto] })
  photos!: ErrandPhotoDto[];
}

export class SavedStateDto {
  /** Whether the errand is now in your saved list. */
  saved!: boolean;
}

export class SavedErrandItemDto extends FeedItemDto {
  /** The saved errand may have closed since; the status tells. */
  @ApiProperty({ enum: ErrandStatus, enumName: 'ErrandStatus' })
  status!: ErrandStatus;
  savedAt!: Date;
}

import { IsIn, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * `recommended` blends rating, price and estimated time (rating counts most) so the requester sees
 * the best all-round offers first. The others sort by one thing.
 */
export const OFFER_SORTS = ['recommended', 'price_asc', 'eta_asc', 'rating_desc', 'distance_asc'] as const;
export type OfferSort = (typeof OFFER_SORTS)[number];

export class OfferListQueryDto {
  @ApiPropertyOptional({
    enum: OFFER_SORTS,
    default: 'price_asc',
    description:
      'Sort order. Ties break by Runner Pro first (never overrides the chosen sort), then oldest offer, then id.',
  })
  @IsOptional()
  @IsIn(OFFER_SORTS as unknown as string[])
  sort?: OfferSort;
}

export class OfferListItemDto {
  @ApiProperty({ description: 'Offer ID' })
  id!: string;

  @ApiProperty({ description: 'Runner user ID' })
  runnerId!: string;

  @ApiProperty({ description: 'Runner display name' })
  runnerName!: string;

  @ApiProperty({ description: 'Current profile photo media id, if any', nullable: true })
  runnerPhotoMediaId!: string | null;

  @ApiProperty({ description: 'Runner has a valid identity verification' })
  runnerVerified!: boolean;

  @ApiProperty({ description: 'Runner average rating (1-5). Null until the runner has enough published ratings.', nullable: true })
  runnerRating!: number | null;

  @ApiProperty({ description: 'Errands this runner has completed.' })
  runnerCompletedErrands!: number;

  @ApiProperty({ type: String, isArray: true, description: 'Earned badges, strongest first (display only; they never change the order).' })
  runnerBadges!: string[];

  @ApiProperty({ description: 'Runner has an active Runner Pro entitlement' })
  runnerIsPro!: boolean;

  @ApiProperty({ description: 'Offer amount in kobo' })
  amountMinor!: number;

  @ApiProperty({ description: 'Estimated duration in minutes' })
  durationMinutes!: number;

  @ApiPropertyOptional({ description: 'Message from the runner' })
  message?: string;

  @ApiProperty({ description: 'Bucketed distance from the runner area centre to the errand, e.g. "< 2 km"', nullable: true })
  distanceBucket!: string | null;

  @ApiProperty({ description: 'Which party must act next', enum: ['RUNNER', 'REQUESTER', 'NONE'] })
  awaitingParty!: string;

  @ApiProperty({ description: 'The runner must reconfirm after a material errand edit; cannot be selected until then' })
  needsReconfirmation!: boolean;

  @ApiProperty({ description: 'Offer version, send back as expectedVersion' })
  version!: number;

  @ApiProperty({ type: Date })
  createdAt!: Date;
}

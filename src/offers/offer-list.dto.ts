import { IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class OfferListQueryDto {
  @ApiProperty({
    enum: ['price_asc', 'eta_asc', 'rating_desc', 'distance_asc'],
    required: false,
    default: 'price_asc',
    description: 'Sort order for offers. Pro runners always appear first within any sort.',
  })
  @IsOptional()
  @IsEnum(['price_asc', 'eta_asc', 'rating_desc', 'distance_asc'])
  sort?: 'price_asc' | 'eta_asc' | 'rating_desc' | 'distance_asc' = 'price_asc';
}

export class OfferListItemDto {
  @ApiProperty({ description: 'Offer ID' })
  id: string;

  @ApiProperty({ description: 'Runner user ID' })
  runnerId: string;

  @ApiProperty({ description: 'Runner display name' })
  runnerName: string;

  @ApiProperty({ description: 'Runner rating (0-5)', nullable: true })
  runnerRating: number | null;

  @ApiProperty({ description: 'Whether the runner has Pro status' })
  runnerIsPro: boolean;

  @ApiProperty({ description: 'Offer amount in kobo (minor currency units)' })
  amountMinor: number;

  @ApiProperty({ description: 'Estimated duration in minutes' })
  durationMinutes: number;

  @ApiProperty({ description: 'Optional message from runner', required: false })
  message?: string;

  @ApiProperty({ description: 'Which party should act next', enum: ['RUNNER', 'REQUESTER', 'NONE'] })
  awaitingParty: string;

  @ApiProperty({ description: 'Whether the offer needs reconfirmation after material edit' })
  needsReconfirmation: boolean;

  @ApiProperty({ description: 'Offer version for optimistic locking' })
  version: number;

  @ApiProperty({ description: 'When the offer was created' })
  createdAt: Date;
}

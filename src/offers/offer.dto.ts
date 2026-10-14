import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { AwaitingParty, OfferStatus } from './offer.service.js';

export class SubmitOfferDto {
  @ApiProperty({ description: 'Offered amount in kobo. Bounds come from OFFER_MIN_AMOUNT / OFFER_MAX_AMOUNT.' })
  @IsInt()
  @Min(1)
  amountMinor!: number;

  @ApiProperty({ description: 'Estimated duration in minutes (5-1440 by default).' })
  @IsInt()
  @Min(1)
  @Max(1440)
  durationMinutes!: number;

  @ApiProperty({ description: 'The runner confirms they are available. Must be true; the server records the time.' })
  @IsBoolean()
  availabilityConfirmed!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message?: string;
}

export class CounterOfferDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  amountMinor!: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(1440)
  durationMinutes!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message?: string;

  @ApiPropertyOptional({ description: 'Reject with OFFER_VERSION_MISMATCH if the offer changed since it was read.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

/** Body of actions that carry only the version the caller last saw. */
export class OfferVersionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

export class OfferDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  errandId!: string;

  @ApiProperty()
  runnerId!: string;

  @ApiProperty()
  requesterId!: string;

  @ApiProperty()
  amountMinor!: number;

  @ApiProperty()
  durationMinutes!: number;

  @ApiProperty({ enum: ['ACTIVE', 'WITHDRAWN', 'REJECTED', 'SELECTED', 'EXPIRED', 'CLOSED'] })
  status!: OfferStatus;

  @ApiProperty({ enum: ['RUNNER', 'REQUESTER', 'NONE'] })
  awaitingParty!: AwaitingParty;

  @ApiProperty()
  version!: number;

  @ApiProperty()
  needsReconfirmation!: boolean;

  @ApiPropertyOptional()
  closeReason?: string;

  @ApiPropertyOptional()
  conversationId?: string;

  @ApiProperty({ type: Date })
  createdAt!: Date;

  @ApiProperty({ type: Date })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: Date })
  availabilityConfirmedAt?: Date;

  @ApiPropertyOptional()
  message?: string;
}

export class NegotiationEventDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ['INITIAL_OFFER', 'COUNTER_OFFER', 'ACCEPT', 'REJECT', 'WITHDRAW', 'SYSTEM_EVENT'] })
  type!: string;

  @ApiProperty()
  actorUserId!: string;

  @ApiProperty({ nullable: true })
  amountMinor!: number | null;

  @ApiProperty({ nullable: true })
  durationMinutes!: number | null;

  @ApiProperty({ nullable: true })
  message!: string | null;

  @ApiProperty({ type: Date })
  createdAt!: Date;
}

export class OfferNegotiationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  errandId!: string;

  @ApiProperty()
  runnerId!: string;

  @ApiProperty()
  requesterId!: string;

  @ApiProperty()
  amountMinor!: number;

  @ApiProperty()
  durationMinutes!: number;

  @ApiProperty({ enum: ['ACTIVE', 'WITHDRAWN', 'REJECTED', 'SELECTED', 'EXPIRED', 'CLOSED'] })
  status!: OfferStatus;

  @ApiProperty({ enum: ['RUNNER', 'REQUESTER', 'NONE'] })
  awaitingParty!: AwaitingParty;

  @ApiProperty()
  version!: number;

  @ApiProperty()
  needsReconfirmation!: boolean;

  @ApiProperty({ nullable: true })
  closeReason!: string | null;

  @ApiProperty({ nullable: true })
  conversationId!: string | null;

  @ApiProperty({ type: Date })
  createdAt!: Date;

  @ApiProperty({ type: Date })
  updatedAt!: Date;

  @ApiProperty({ type: Date, nullable: true })
  availabilityConfirmedAt!: Date | null;

  @ApiProperty({ nullable: true })
  message!: string | null;

  @ApiProperty({ nullable: true })
  assignmentId!: string | null;

  @ApiProperty()
  errandTitle!: string;

  @ApiProperty({ type: () => NegotiationEventDto, isArray: true })
  history!: NegotiationEventDto[];
}

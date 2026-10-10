import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import type { AwaitingParty, OfferStatus } from './offer.service.js';

export class SubmitOfferDto {
  @ApiProperty({ description: 'Errand requester ID for the offer context. The current authenticated user is the runner.' })
  @IsString()
  requesterId!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  amountMinor!: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(1440)
  durationMinutes!: number;

  @ApiPropertyOptional({ type: Date, description: 'When the runner confirmed availability for this errand.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  availabilityConfirmedAt?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  message?: string;

  @ApiPropertyOptional({ enum: ['OPEN'], default: 'OPEN' })
  @IsOptional()
  status?: 'OPEN';
}

export class CounterOfferDto {
  @ApiProperty()
  @IsInt()
  @Min(0)
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
  message?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

export class ReconfirmOfferDto {
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

  @ApiPropertyOptional()
  availabilityConfirmedAt?: Date;

  @ApiPropertyOptional()
  message?: string;
}

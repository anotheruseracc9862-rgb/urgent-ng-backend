import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination/pagination.dto.js';

const STATUSES = ['ACTIVE', 'WITHDRAWN', 'REJECTED', 'SELECTED', 'EXPIRED', 'CLOSED'] as const;

export class RunnerOffersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: STATUSES, description: 'Only offers in this status.' })
  @IsOptional()
  @IsIn(STATUSES as unknown as string[])
  status?: (typeof STATUSES)[number];
}

export class RunnerOfferSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  errandId!: string;

  @ApiProperty({ enum: STATUSES })
  status!: string;

  @ApiProperty({ enum: ['RUNNER', 'REQUESTER', 'NONE'] })
  awaitingParty!: string;

  @ApiProperty()
  amountMinor!: number;

  @ApiProperty()
  durationMinutes!: number;

  @ApiProperty()
  needsReconfirmation!: boolean;

  @ApiProperty()
  version!: number;

  @ApiProperty({ nullable: true })
  closeReason!: string | null;

  @ApiProperty()
  errandTitle!: string;

  @ApiProperty()
  errandStatus!: string;

  @ApiProperty({ nullable: true, description: 'Approximate area only.' })
  pickupArea!: string | null;

  @ApiProperty({ nullable: true, description: 'Approximate area only.' })
  destinationArea!: string | null;

  @ApiProperty({ type: Date })
  createdAt!: Date;
}

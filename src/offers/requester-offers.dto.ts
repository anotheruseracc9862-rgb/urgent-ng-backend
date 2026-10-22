import { ApiProperty } from '@nestjs/swagger';
import { RunnerOffersQueryDto } from './runner-offers.dto.js';

export class RequesterOffersQueryDto extends RunnerOffersQueryDto {}

/** One offer on one of the requester's errands, with enough to act on it from a single list. */
export class RequesterOfferSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  errandId!: string;

  @ApiProperty({ enum: ['ACTIVE', 'WITHDRAWN', 'REJECTED', 'SELECTED', 'EXPIRED', 'CLOSED'] })
  status!: string;

  @ApiProperty({ enum: ['RUNNER', 'REQUESTER', 'NONE'], description: 'Whose move it is. REQUESTER: the offer or counter is waiting for the requester.' })
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

  @ApiProperty({ enum: ['TRANSIT', 'SERVICE'] })
  categoryFlow!: 'TRANSIT' | 'SERVICE';

  @ApiProperty({ description: "The runner's first name." })
  runnerFirstName!: string;

  @ApiProperty({ nullable: true, type: Number, description: 'Public average rating, once there are enough ratings.' })
  runnerRating!: number | null;

  @ApiProperty()
  runnerCompletedErrands!: number;

  @ApiProperty({ type: Date })
  createdAt!: Date;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination/pagination.dto.js';
import { LatLngDto } from '../runner/runner.dto.js';

const STATUSES = ['PENDING_ACCEPTANCE', 'ACCEPTED', 'DECLINED', 'TIMED_OUT', 'CANCELLED', 'COMPLETED'] as const;

export class RunnerAssignmentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: [...STATUSES, 'ACTIVE', 'PAST'],
    description: 'ACTIVE is pending plus accepted; PAST is declined, timed out, cancelled and completed. Or one exact status.',
  })
  @IsOptional()
  @IsIn([...STATUSES, 'ACTIVE', 'PAST'])
  status?: (typeof STATUSES)[number] | 'ACTIVE' | 'PAST';

  @ApiPropertyOptional({ description: 'Search the errand title or the requester name.', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Only assignments selected on or after this.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Only assignments selected before this.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

/** The filters of the history export (no paging: the file holds every match, up to a limit). */
export class RunnerHistoryExportQueryDto {
  @ApiPropertyOptional({ enum: [...STATUSES, 'ACTIVE', 'PAST'] })
  @IsOptional()
  @IsIn([...STATUSES, 'ACTIVE', 'PAST'])
  status?: (typeof STATUSES)[number] | 'ACTIVE' | 'PAST';

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

export class HistorySummaryQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 24, default: 12, description: 'How many months back, counting this one.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  months?: number = 12;
}

export class HistoryMonthDto {
  @ApiProperty({ example: '2026-10', description: 'Month in Lagos time.' })
  month!: string;
  @ApiProperty({ description: 'Assignments completed that were selected in this month.' })
  completed!: number;
  @ApiProperty({ description: 'Cancelled after selection.' })
  cancelled!: number;
  @ApiProperty({ description: 'Declined or timed out before the runner accepted.' })
  notAccepted!: number;
  @ApiProperty({ description: 'The sum of the agreed amounts of completed assignments, in kobo. A record, not a payout.' })
  agreedTotalMinor!: number;
}

export class HistorySummaryDto {
  @ApiProperty({ type: HistoryMonthDto, isArray: true })
  months!: HistoryMonthDto[];
  @ApiProperty({ description: 'Completed assignments in the whole period.' })
  completed!: number;
  @ApiProperty({ description: 'Every assignment in the period that was selected.' })
  total!: number;
}

export class RunnerAssignmentSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  errandId!: string;

  @ApiProperty({ enum: STATUSES })
  status!: string;

  @ApiProperty({ description: 'The errand status, which is also the execution status.' })
  errandStatus!: string;

  @ApiProperty()
  errandTitle!: string;

  @ApiProperty()
  agreedAmountMinor!: number;

  @ApiProperty({ type: Date })
  acceptanceDeadline!: Date;

  @ApiPropertyOptional({ type: Date, nullable: true })
  acceptedAt!: Date | null;

  @ApiProperty({ nullable: true, description: 'Approximate area only. Use GET /assignments/:id for exact data once accepted.' })
  pickupArea!: string | null;

  @ApiProperty({ nullable: true })
  destinationArea!: string | null;

  @ApiProperty({ type: LatLngDto, nullable: true, description: 'The approximate pickup point (about 500 m grid), for a map. Never the exact point.' })
  pickupApprox!: LatLngDto | null;

  @ApiProperty({ type: LatLngDto, nullable: true, description: 'The approximate destination point, for a map. Never the exact point.' })
  destinationApprox!: LatLngDto | null;

  @ApiProperty({ enum: ['TRANSIT', 'SERVICE'], description: 'A service has no pickup: its one address is the destination.' })
  categoryFlow!: 'TRANSIT' | 'SERVICE';

  @ApiProperty({ type: Date })
  selectedAt!: Date;

  @ApiProperty({ description: "The requester's first name." })
  requesterFirstName!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The conversation with the requester about this errand, if one exists. Open it at /conversations/{id}.',
  })
  conversationId!: string | null;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination/pagination.dto.js';

const STATUSES = ['PENDING_ACCEPTANCE', 'ACCEPTED', 'DECLINED', 'TIMED_OUT', 'CANCELLED', 'COMPLETED'] as const;

export class RunnerAssignmentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: [...STATUSES, 'ACTIVE', 'PAST'],
    description: 'ACTIVE is pending plus accepted; PAST is declined, timed out, cancelled and completed. Or one exact status.',
  })
  @IsOptional()
  @IsIn([...STATUSES, 'ACTIVE', 'PAST'])
  status?: (typeof STATUSES)[number] | 'ACTIVE' | 'PAST';
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

  @ApiProperty({ type: Date })
  selectedAt!: Date;
}

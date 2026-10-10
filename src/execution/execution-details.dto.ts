import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

const PROBLEM_TYPES = ['ITEM_NOT_READY', 'RECIPIENT_UNREACHABLE', 'WRONG_ADDRESS', 'ITEM_PROBLEM', 'OTHER'] as const;
const DELAY_REASONS = ['TRAFFIC', 'ITEM_NOT_READY', 'QUEUE', 'TRANSPORT', 'PERSONAL', 'OTHER'] as const;

export class ReportProblemDto {
  @ApiProperty({ enum: PROBLEM_TYPES })
  @IsIn(PROBLEM_TYPES as unknown as string[])
  type!: (typeof PROBLEM_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ description: 'A READY upload of purpose PICKUP_EVIDENCE owned by the runner. Both parties can view it.' })
  @IsOptional()
  @IsUUID()
  mediaId?: string;
}

export class ProblemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  assignmentId!: string;

  @ApiProperty({ enum: PROBLEM_TYPES })
  type!: string;

  @ApiProperty({ nullable: true })
  note!: string | null;

  @ApiProperty({ nullable: true })
  mediaId!: string | null;

  @ApiProperty({ enum: ['OPEN', 'RESOLVED'] })
  status!: string;

  @ApiProperty({ type: Date })
  createdAt!: Date;

  @ApiProperty({ type: Date, nullable: true })
  resolvedAt!: Date | null;

  @ApiProperty({ description: 'Two unresolved problems on one assignment suggest a dispute to both parties (PRD 15.4).' })
  suggestDispute!: boolean;
}

export class DelayNoticeDto {
  @ApiProperty({ enum: DELAY_REASONS })
  @IsIn(DELAY_REASONS as unknown as string[])
  reason!: (typeof DELAY_REASONS)[number];

  @ApiProperty({ description: 'The new estimate: minutes from now until the errand is done.' })
  @IsInt()
  @Min(1)
  @Max(1440)
  newEstimateMinutes!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

export class ReceiptDto {
  @ApiProperty({ description: 'A READY upload of purpose PURCHASE_RECEIPT owned by the runner.' })
  @IsUUID()
  mediaId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

export class ExecutionEventDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  type!: string;

  @ApiProperty({ enum: ['USER', 'ADMIN', 'SYSTEM', 'WORKER', 'PROVIDER'] })
  actorType!: string;

  @ApiProperty({ nullable: true })
  actorId!: string | null;

  @ApiProperty({ nullable: true })
  note!: string | null;

  @ApiProperty({ nullable: true })
  mediaId!: string | null;

  @ApiProperty({ type: Object, nullable: true })
  metadata!: Record<string, unknown> | null;

  @ApiProperty({ type: Date })
  createdAt!: Date;
}

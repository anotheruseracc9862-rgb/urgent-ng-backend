import { ApiProperty } from '@nestjs/swagger';

export class ReliabilityEventViewDto {
  @ApiProperty()
  id!: string;
  @ApiProperty({ description: 'The kind of fact, for example ASSIGNMENT_CANCELLED or NO_SHOW.' })
  type!: string;
  @ApiProperty({ description: 'Points this fact adds inside the rolling window.' })
  points!: number;
  @ApiProperty({ type: Date })
  occurredAt!: Date;
  @ApiProperty({ nullable: true, type: String })
  errandId!: string | null;
  @ApiProperty({ nullable: true, type: String })
  assignmentId!: string | null;
  @ApiProperty({ enum: ['USER', 'ADMIN', 'SYSTEM', 'WORKER', 'PROVIDER'] })
  source!: string;
}

export class ReliabilityThresholdsDto {
  @ApiProperty()
  warning!: number;
  @ApiProperty()
  restriction!: number;
  @ApiProperty()
  suspension!: number;
  @ApiProperty()
  adminReview!: number;
}

/** The caller's own reliability: the points and every event behind them (Backend PRD 21.1). */
export class ReliabilityExplanationDto {
  @ApiProperty({ description: 'Length of the rolling window in days.' })
  windowDays!: number;
  @ApiProperty({ description: 'Points inside the window.' })
  points!: number;
  @ApiProperty({ type: ReliabilityThresholdsDto })
  thresholds!: ReliabilityThresholdsDto;
  @ApiProperty({ enum: ['WARNING', 'RESTRICTION', 'SUSPENSION', 'ADMIN_REVIEW'], nullable: true })
  reached!: string | null;
  @ApiProperty({ type: ReliabilityEventViewDto, isArray: true })
  events!: ReliabilityEventViewDto[];
}

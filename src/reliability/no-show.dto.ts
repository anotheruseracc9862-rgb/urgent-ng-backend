import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const NO_SHOW_RESPONSES = ['PRESENT', 'ACKNOWLEDGE'] as const;

export class ReportNoShowDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RespondNoShowDto {
  @ApiProperty({
    enum: NO_SHOW_RESPONSES,
    description: 'PRESENT: you are there or did take part, an admin will decide. ACKNOWLEDGE: you accept the no-show.',
  })
  @IsIn(NO_SHOW_RESPONSES as unknown as string[])
  response!: (typeof NO_SHOW_RESPONSES)[number];
}

export class NoShowReportDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  assignmentId!: string;
  @ApiProperty({ enum: ['PENDING', 'CONFIRMED', 'CONTESTED', 'DISMISSED'] })
  status!: string;
  @ApiProperty({ description: 'The caller filed this report (otherwise they are the person it is about).' })
  reportedByMe!: boolean;
  @ApiProperty({ nullable: true, type: String })
  note!: string | null;
  @ApiProperty({ type: Date, description: 'Until when the person reported can answer before it is confirmed.' })
  responseDueAt!: Date;
  @ApiProperty({ type: Date, nullable: true })
  respondedAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true })
  resolvedAt!: Date | null;
  @ApiProperty({ enum: ['ACKNOWLEDGED', 'NO_RESPONSE', 'ADMIN'], nullable: true })
  resolutionSource!: string | null;
  @ApiProperty({ type: Date })
  createdAt!: Date;
}

export class NoShowStateDto {
  @ApiProperty({ type: NoShowReportDto, nullable: true, description: 'The current open report, else the latest one.' })
  report!: NoShowReportDto | null;
  @ApiProperty({ description: 'The caller may file a report now.' })
  canReport!: boolean;
  @ApiProperty({ type: Date, nullable: true, description: 'The earliest time a report may be filed (null when the assignment is not active).' })
  earliestReportAt!: Date | null;
}

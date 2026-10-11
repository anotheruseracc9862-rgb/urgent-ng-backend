import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination/pagination.dto.js';
import { EvidenceDto, EvidenceItemDto } from '../disputes/dispute.dto.js';

export const REPORT_TARGETS = ['USER', 'ERRAND', 'MESSAGE', 'RATING'] as const;

export const REPORT_TYPES = [
  'USER_BEHAVIOR',
  'ERRAND',
  'NON_PAYMENT',
  'OVERCHARGING',
  'LOST_ITEM',
  'DAMAGED_ITEM',
  'ABUSE',
  'HARASSMENT',
  'FRAUD',
  'UNSAFE_BEHAVIOR',
  'PROHIBITED_ITEM',
  'SPAM',
  'FAKE_ACCOUNT',
  'OTHER',
] as const;

export class CreateReportDto {
  @ApiProperty({ enum: REPORT_TARGETS })
  @IsIn(REPORT_TARGETS as unknown as string[])
  targetType!: (typeof REPORT_TARGETS)[number];

  @ApiProperty({ description: 'The user, errand, message or rating being reported.' })
  @IsUUID()
  targetId!: string;

  @ApiProperty({ enum: REPORT_TYPES })
  @IsIn(REPORT_TYPES as unknown as string[])
  type!: (typeof REPORT_TYPES)[number];

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;

  @ApiPropertyOptional({ description: 'The assignment this is about, when reporting a user.' })
  @IsOptional()
  @IsUUID()
  assignmentId?: string;

  @ApiPropertyOptional({ type: EvidenceItemDto, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => EvidenceItemDto)
  evidence?: EvidenceItemDto[];
}

/** `POST /ratings/:id/report`: the rating is the target. */
export class ReportRatingDto {
  @ApiProperty({ enum: REPORT_TYPES })
  @IsIn(REPORT_TYPES as unknown as string[])
  type!: (typeof REPORT_TYPES)[number];

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;
}

export class ReportListQueryDto extends PaginationQueryDto {}

export class ReportDto {
  @ApiProperty()
  id!: string;
  @ApiProperty({ enum: REPORT_TARGETS })
  targetType!: string;
  @ApiProperty({ enum: REPORT_TYPES })
  type!: string;
  @ApiProperty({ enum: ['OPEN', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'RESOLVED', 'DISMISSED', 'CLOSED'] })
  status!: string;
  @ApiProperty()
  description!: string;
  @ApiProperty({ nullable: true, type: String })
  errandId!: string | null;
  @ApiProperty({ enum: ['UPHELD', 'DISMISSED'], nullable: true, description: 'The decision, once made. Internal notes are never shown.' })
  outcome!: string | null;
  @ApiProperty({ type: Date, nullable: true })
  resolvedAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true, description: 'When Urgent.ng aims to respond first.' })
  firstResponseDueAt!: Date | null;
  @ApiProperty({ description: 'While open, this report holds the errand from being completed automatically.' })
  pausesAutoCompletion!: boolean;
  @ApiProperty({ type: EvidenceDto, isArray: true })
  evidence!: EvidenceDto[];
  @ApiProperty({ type: Date })
  createdAt!: Date;
}

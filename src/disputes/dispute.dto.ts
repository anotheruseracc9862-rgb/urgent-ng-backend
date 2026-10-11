import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';

export const DISPUTE_TYPES = [
  'ITEM_NOT_DELIVERED',
  'ITEM_DAMAGED',
  'ITEM_MISSING',
  'WRONG_ITEM',
  'UNAUTHORIZED_CHANGE',
  'SAFETY_INCIDENT',
  'OTHER',
] as const;

export const EVIDENCE_SOURCES = ['MESSAGE', 'MEDIA', 'CHECKPOINT', 'EXECUTION_EVENT', 'STATEMENT'] as const;

export class EvidenceItemDto {
  @ApiProperty({ enum: EVIDENCE_SOURCES })
  @IsIn(EVIDENCE_SOURCES as unknown as string[])
  sourceType!: (typeof EVIDENCE_SOURCES)[number];

  @ApiPropertyOptional({ description: 'The message, media, checkpoint or execution event id. Not used for a statement.' })
  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @ApiPropertyOptional({ maxLength: 2000, description: 'The text of a STATEMENT, or a short note on another item.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  statement?: string;
}

export class OpenDisputeDto {
  @ApiProperty({ enum: DISPUTE_TYPES })
  @IsIn(DISPUTE_TYPES as unknown as string[])
  type!: (typeof DISPUTE_TYPES)[number];

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  claim!: string;

  @ApiPropertyOptional({ type: EvidenceItemDto, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => EvidenceItemDto)
  evidence?: EvidenceItemDto[];
}

export class EvidenceDto {
  @ApiProperty()
  id!: string;
  @ApiProperty({ enum: EVIDENCE_SOURCES })
  sourceType!: string;
  @ApiProperty({ nullable: true, type: String })
  sourceId!: string | null;
  @ApiProperty({ nullable: true, type: String })
  statement!: string | null;
  @ApiProperty({ description: 'The caller added this item.' })
  addedByMe!: boolean;
  @ApiProperty({ type: Date })
  createdAt!: Date;
}

export class DisputeDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  errandId!: string;
  @ApiProperty()
  assignmentId!: string;
  @ApiProperty({ description: 'The caller opened the dispute.' })
  openedByMe!: boolean;
  @ApiProperty({ enum: DISPUTE_TYPES })
  type!: string;
  @ApiProperty({ enum: ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CLOSED'] })
  status!: string;
  @ApiProperty()
  claim!: string;
  @ApiProperty({ enum: ['COMPLETE', 'CANCEL', 'DISMISS'], nullable: true })
  resolution!: string | null;
  @ApiProperty({ nullable: true, type: String })
  resolutionNotes!: string | null;
  @ApiProperty({ type: Date, nullable: true })
  resolvedAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true, description: 'When Urgent.ng aims to respond first.' })
  firstResponseDueAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true, description: 'When Urgent.ng aims to have decided.' })
  resolutionDueAt!: Date | null;
  @ApiProperty({ description: 'Evidence can still be added.' })
  canAddEvidence!: boolean;
  @ApiProperty({ type: EvidenceDto, isArray: true })
  evidence!: EvidenceDto[];
  @ApiProperty({ type: Date })
  createdAt!: Date;
}

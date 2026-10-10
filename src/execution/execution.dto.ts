import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsLatitude, IsLongitude, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class CheckpointInputDto {
  @ApiProperty({ description: 'Where the runner confirms the step. Stored privately; never shown to anyone but the parties.' })
  @IsLatitude()
  lat!: number;

  @ApiProperty()
  @IsLongitude()
  lng!: number;

  @ApiPropertyOptional({ type: Date, description: 'When the point was captured on the device. Defaults to now.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  capturedAt?: Date;
}

/** Optional evidence for pickup and delivery (Backend PRD 15.1). */
export class StepEvidenceDto {
  @ApiPropertyOptional({ description: 'A note about the step, or the recipient on delivery.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ description: 'A READY upload of purpose PICKUP_EVIDENCE or DELIVERY_EVIDENCE owned by the runner.' })
  @IsOptional()
  @IsUUID()
  mediaId?: string;

  @ApiPropertyOptional({ type: CheckpointInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CheckpointInputDto)
  checkpoint?: CheckpointInputDto;
}

export class ExecutionStepDto {
  @ApiProperty()
  assignmentId!: string;

  @ApiProperty()
  errandId!: string;

  @ApiProperty({ description: 'The errand status after the step. Errand status is the execution status.' })
  errandStatus!: string;

  @ApiProperty({ description: 'The execution event written for the step.' })
  eventId!: string;

  @ApiProperty({ enum: ['STARTED', 'PICKED_UP', 'DELIVERED', 'COMPLETED', 'AUTO_COMPLETED'] })
  type!: string;

  @ApiProperty({ type: Date })
  at!: Date;

  @ApiPropertyOptional({ type: Date, nullable: true, description: 'Set after delivery: when the errand completes by itself if the requester does not respond.' })
  autoCompleteAt!: Date | null;
}

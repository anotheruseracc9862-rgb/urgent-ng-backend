import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsNumber, IsOptional, Max, Min } from 'class-validator';

/** A position update from the runner's device. Client location is untrusted input (Backend PRD 17.3). */
export class ReportLocationDto {
  @ApiProperty({ minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @ApiPropertyOptional({ description: 'Metres, when the device reports it.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000)
  accuracyMeters?: number;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'When the device read the position. Never trusted past "now".' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  capturedAt?: Date;
}

export class SharingDto {
  @ApiProperty({ description: 'false stops sharing for this errand; true resumes it.' })
  @IsBoolean()
  enabled!: boolean;
}

export class RecordedLocationDto {
  @ApiProperty({ description: 'false when the update was valid but not stored (the runner has not moved).' })
  recorded!: boolean;
  @ApiProperty({ enum: ['STORED', 'NO_MOVEMENT'] })
  result!: string;
}

export class SharingStateDto {
  @ApiProperty()
  assignmentId!: string;
  @ApiProperty({ description: 'The runner is sharing their location for this errand.' })
  enabled!: boolean;
}

export class LivePointDto {
  @ApiProperty()
  lat!: number;
  @ApiProperty()
  lng!: number;
}

/**
 * The runner's position as a reader may see it (Backend PRD 17.4): rounded to about 250 m, with
 * how old it is. A stale location is labelled, an expired one has no point.
 */
export class LiveLocationDto {
  @ApiProperty()
  assignmentId!: string;
  @ApiProperty({ description: 'The errand status the live view belongs to.' })
  errandStatus!: string;
  @ApiProperty({ enum: ['ACTIVE', 'STOPPED'], description: 'STOPPED: the runner turned location sharing off.' })
  sharing!: string;
  @ApiProperty({ enum: ['FRESH', 'STALE', 'EXPIRED', 'NONE'] })
  freshness!: string;
  @ApiProperty({ type: LivePointDto, nullable: true, description: 'Rounded position. Null when expired, stopped or never shared.' })
  point!: LivePointDto | null;
  @ApiProperty({ type: Date, nullable: true })
  capturedAt!: Date | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Age of the last position in seconds.' })
  ageSeconds!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Minutes to the next stop. Only given when the position is fresh and the maps provider has a traffic-aware estimate.',
  })
  estimatedArrivalMinutes!: number | null;
}

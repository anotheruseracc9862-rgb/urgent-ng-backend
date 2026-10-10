import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { RunnerAvailability, TransportMethod } from '@prisma/client';

export class LatLngDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;
}

export class UpdateRunnerProfileDto {
  @ApiProperty({ enum: TransportMethod, enumName: 'TransportMethod' })
  @IsEnum(TransportMethod)
  transport!: TransportMethod;

  /** Centre of the operating circle. */
  @ApiProperty({ type: LatLngDto })
  @ValidateNested()
  @Type(() => LatLngDto)
  areaCenter!: LatLngDto;

  /** Radius in km, one decimal. Must be within the configured range (default 1 to 20); default 5. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  areaRadiusKm?: number;

  /** Categories the runner never wants to see. Default none. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  excludedCategoryIds?: string[];
}

export class UpdateAvailabilityDto {
  @ApiProperty({ enum: RunnerAvailability, enumName: 'RunnerAvailability' })
  @IsEnum(RunnerAvailability)
  availability!: RunnerAvailability;
}

export class RunnerProfileDto {
  @ApiProperty({ enum: TransportMethod, enumName: 'TransportMethod' })
  transport!: TransportMethod;
  @ApiProperty({ type: LatLngDto })
  areaCenter!: LatLngDto;
  areaRadiusKm!: number;
  @ApiProperty({ enum: RunnerAvailability, enumName: 'RunnerAvailability' })
  availability!: RunnerAvailability;
  @ApiProperty({ type: [String] })
  excludedCategoryIds!: string[];
}

export class RunnerEligibilityDto {
  /** True when the runner may submit offers right now. */
  canOffer!: boolean;
  /** True when the runner may browse the feed right now. */
  canBrowseFeed!: boolean;
  @ApiProperty({
    type: [String],
    enum: ['ACCOUNT_NOT_ACTIVE', 'PHONE_NOT_VERIFIED', 'NOT_VERIFIED', 'VERIFICATION_PENDING', 'NO_RUNNER_PROFILE', 'UNAVAILABLE', 'RESTRICTED'],
  })
  reasons!: string[];
  @ApiPropertyOptional()
  note?: string;
}

export class RunnerOfferLimitDto {
  @ApiProperty()
  used!: number;
  @ApiProperty()
  limit!: number;
  @ApiProperty()
  remaining!: number;
  @ApiProperty({ type: Date })
  resetsAt!: Date;
  @ApiProperty()
  isPro!: boolean;
  @ApiProperty()
  isAtLimit!: boolean;
}

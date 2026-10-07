import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  ConsentType,
  DeviceType,
  NotificationCategory,
  NotificationChannel,
  StartMode,
} from '@prisma/client';

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  /** What the user chose to do first. A preference only: no permission check may read it. */
  @IsOptional()
  @IsEnum(StartMode)
  startMode?: StartMode;
}

export class AccountReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PreferenceEntryDto {
  @IsEnum(NotificationCategory)
  category!: NotificationCategory;

  @IsEnum(NotificationChannel)
  channel!: NotificationChannel;

  @IsBoolean()
  enabled!: boolean;
}

export class UpdatePreferencesDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PreferenceEntryDto)
  preferences!: PreferenceEntryDto[];
}

export class AcceptConsentDto {
  @IsEnum(ConsentType)
  type!: ConsentType;

  @IsString()
  @MaxLength(50)
  version!: string;
}

export class RegisterDeviceDto {
  @IsEnum(DeviceType)
  type!: DeviceType;

  @IsString()
  @MinLength(8)
  @MaxLength(4096)
  pushToken!: string;
}

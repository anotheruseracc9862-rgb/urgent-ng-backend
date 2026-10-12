import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsNigerianPhone, NormalisePhone, NormaliseEmail } from '../identifier.js';
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

  /** A short line about the user, shown on the public profile. `null` clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  bio?: string | null;

  /** Where the user is based, for example "Lagos - Lekki & Ajah". `null` clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  homeArea?: string | null;
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

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class QuietHoursDto {
  /** HH:mm in Lagos time, or null together with `end` to go back to the default window. */
  @ValidateIf((_, value) => value !== null)
  @Matches(HH_MM, { message: 'start must be HH:mm' })
  start!: string | null;

  @ValidateIf((_, value) => value !== null)
  @Matches(HH_MM, { message: 'end must be HH:mm' })
  end!: string | null;
}

export class ChangePasswordDto {
  /** The current password. An account created with Google has none: send `googleIdToken` instead. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword?: string;

  /** A fresh Google ID token for the linked Google account, for an account with no password yet. */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  googleIdToken?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}

/** Add or change the phone number or email of the account. Exactly one of the two. */
export class ContactChangeRequestDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword?: string;

  /** A fresh Google ID token, for an account that has no password yet. */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  googleIdToken?: string;

  @IsOptional()
  @NormalisePhone()
  @IsNigerianPhone()
  phone?: string;

  @IsOptional()
  @NormaliseEmail()
  @IsEmail()
  @MaxLength(255)
  email?: string;
}

export class ContactChangeVerifyDto {
  @IsOptional()
  @NormalisePhone()
  @IsNigerianPhone()
  phone?: string;

  @IsOptional()
  @NormaliseEmail()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @Matches(/^\d{6}$/, { message: 'The code is 6 digits' })
  code!: string;
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

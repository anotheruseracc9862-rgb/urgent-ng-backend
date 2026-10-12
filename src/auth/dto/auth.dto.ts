import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ConsentType } from '@prisma/client';
import { IsNigerianPhone, NormaliseEmail, NormalisePhone } from '../identifier.js';

/** A request names its account by phone OR email (the service checks exactly one). */
export class IdentifierDto {
  /** Any common Nigerian format; stored as +234XXXXXXXXXX. */
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

export class ConsentInputDto {
  @IsEnum(ConsentType)
  type!: ConsentType;

  @IsString()
  @MaxLength(50)
  version!: string;
}

export class RegisterDto extends IdentifierDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ConsentInputDto)
  consents!: ConsentInputDto[];

  /** Where the person is based, for example "Lagos - Lekki & Ajah". Optional. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  homeArea?: string;
}

export class GoogleSignInDto {
  /** The ID token from Google's sign-in button. Used once, never stored. */
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  idToken!: string;

  /** Needed only when no account exists yet for this Google user (the first sign-in). */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConsentInputDto)
  consents?: ConsentInputDto[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  homeArea?: string;
}

export class VerifyOtpDto extends IdentifierDto {
  @Matches(/^\d{6}$/, { message: 'The code is 6 digits' })
  code!: string;
}

export class ResendOtpDto extends IdentifierDto {}

export class LoginDto extends IdentifierDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  /** Mobile clients send it here; web clients send it in the `ung_rt` cookie. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;
}

export class ForgotPasswordDto extends IdentifierDto {}

export class ResetPasswordDto extends IdentifierDto {
  @Matches(/^\d{6}$/, { message: 'The code is 6 digits' })
  code!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}

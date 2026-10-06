import { IsString, IsEmail, IsOptional, MinLength, MaxLength, Matches, IsEnum, IsArray, ValidateNested, IsNotEmpty, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Registration DTO (P2-02)
 * Per PRD §9.2:
 * - Name, phone OR email (both are login identifiers, both unique)
 * - Password
 * - Required policy consents with versions
 * - Blocklist check prevents registration
 */

export class ConsentDto {
  @IsEnum(['TERMS_OF_SERVICE', 'PRIVACY_POLICY', 'SAFETY_POLICY', 'PROHIBITED_ITEMS_POLICY'])
  @IsNotEmpty()
  type: string;

  @IsString()
  @IsNotEmpty()
  version: string;

  accepted: true; // Must be true for required consents
}

export class RegisterDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @Matches(/^\+234[0-9]{10}$/, {
    message: 'Phone must be in E.164 format: +234XXXXXXXXXX',
  })
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(100)
  @IsNotEmpty()
  password: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConsentDto)
  consents: ConsentDto[];

  /**
   * Validate that at least one of phone or email is provided
   */
  static validate(dto: RegisterDto): string | null {
    if (!dto.phone && !dto.email) {
      return 'Either phone or email is required';
    }
    return null;
  }
}

export class SendOtpDto {
  @IsOptional()
  @Matches(/^\+234[0-9]{10}$/, {
    message: 'Phone must be in E.164 format: +234XXXXXXXXXX',
  })
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsEnum(['REGISTRATION', 'PASSWORD_RESET', 'PHONE_VERIFICATION', 'EMAIL_VERIFICATION'])
  @IsNotEmpty()
  purpose: string;

  static validate(dto: SendOtpDto): string | null {
    if (!dto.phone && !dto.email) {
      return 'Either phone or email is required';
    }
    return null;
  }
}

export class VerifyOtpDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @Matches(/^\+234[0-9]{10}$/, {
    message: 'Phone must be in E.164 format: +234XXXXXXXXXX',
  })
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsString()
  @Matches(/^[0-9]{6}$/, {
    message: 'OTP must be a 6-digit code',
  })
  @IsNotEmpty()
  code: string;

  @IsEnum(['REGISTRATION', 'PASSWORD_RESET', 'PHONE_VERIFICATION', 'EMAIL_VERIFICATION'])
  @IsNotEmpty()
  purpose: string;

  static validate(dto: VerifyOtpDto): string | null {
    if (!dto.phone && !dto.email) {
      return 'Either phone or email is required';
    }
    return null;
  }
}

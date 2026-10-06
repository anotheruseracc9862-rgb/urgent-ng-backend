import { IsString, IsEmail, IsOptional, Matches, IsNotEmpty, MinLength } from 'class-validator';

/**
 * Login DTOs (P2-03)
 */

export class LoginDto {
  @IsOptional()
  @Matches(/^\+234[0-9]{10}$/, {
    message: 'Phone must be in E.164 format: +234XXXXXXXXXX',
  })
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  password: string;

  static validate(dto: LoginDto): string | null {
    if (!dto.phone && !dto.email) {
      return 'Either phone or email is required';
    }
    return null;
  }
}

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class PasswordResetRequestDto {
  @IsOptional()
  @Matches(/^\+234[0-9]{10}$/, {
    message: 'Phone must be in E.164 format: +234XXXXXXXXXX',
  })
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  static validate(dto: PasswordResetRequestDto): string | null {
    if (!dto.phone && !dto.email) {
      return 'Either phone or email is required';
    }
    return null;
  }
}

export class PasswordResetConfirmDto {
  @IsOptional()
  @Matches(/^\+234[0-9]{10}$/, {
    message: 'Phone must be in E.164 format: +234XXXXXXXXXX',
  })
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @Matches(/^[0-9]{6}$/, {
    message: 'OTP must be a 6-digit code',
  })
  @IsNotEmpty()
  code: string;

  @IsString()
  @MinLength(8)
  @IsNotEmpty()
  newPassword: string;

  static validate(dto: PasswordResetConfirmDto): string | null {
    if (!dto.phone && !dto.email) {
      return 'Either phone or email is required';
    }
    return null;
  }
}

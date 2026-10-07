import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class AdminLoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class MfaTokenDto {
  @IsString()
  @MaxLength(2000)
  mfaToken!: string;
}

export class MfaVerifyDto extends MfaTokenDto {
  @Matches(/^\d{6}$/, { message: 'The code is 6 digits' })
  code!: string;
}

export class AdminRefreshDto {
  /** Non-browser clients send it here; the admin web app uses the `ung_admin_rt` cookie. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;
}

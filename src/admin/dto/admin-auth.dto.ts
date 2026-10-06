import { IsEmail, IsString, MinLength, IsArray, IsOptional } from 'class-validator';

export class AdminLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsString()
  totpCode?: string;
}

export class AdminRefreshDto {
  @IsString()
  refreshToken: string;
}

export class CreateAdminDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsArray()
  @IsString({ each: true })
  roleIds: string[];
}

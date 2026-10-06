import { IsString, IsOptional, MaxLength, MinLength, Matches } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[\p{L}\s'\-]+$/u, {
    message: 'firstName can only contain letters, spaces, hyphens, and apostrophes',
  })
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[\p{L}\s'\-]+$/u, {
    message: 'lastName can only contain letters, spaces, hyphens, and apostrophes',
  })
  lastName?: string;
}

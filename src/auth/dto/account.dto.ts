import { IsString, IsOptional, MaxLength } from 'class-validator';

export class DeactivateAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RequestDeletionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

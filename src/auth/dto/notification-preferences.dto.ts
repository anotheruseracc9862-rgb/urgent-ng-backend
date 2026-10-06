import { IsBoolean, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ChannelPreferencesDto {
  @IsOptional()
  @IsBoolean()
  push?: boolean;

  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @IsOptional()
  @IsBoolean()
  inApp?: boolean;
}

export class UpdatePreferencesDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ChannelPreferencesDto)
  transactional?: ChannelPreferencesDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ChannelPreferencesDto)
  safety?: ChannelPreferencesDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ChannelPreferencesDto)
  marketplace?: ChannelPreferencesDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ChannelPreferencesDto)
  messaging?: ChannelPreferencesDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ChannelPreferencesDto)
  marketing?: ChannelPreferencesDto;
}

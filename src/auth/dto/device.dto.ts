import { IsEnum, IsString } from 'class-validator';
import { DeviceType } from '@prisma/client';

export class RegisterDeviceDto {
  @IsEnum(DeviceType)
  deviceType: DeviceType;

  @IsString()
  pushToken: string;
}

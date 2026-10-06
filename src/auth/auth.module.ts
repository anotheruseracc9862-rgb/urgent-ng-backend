import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module.js';
import { AuthController } from './auth.controller.js';
import { RegistrationService } from './registration.service.js';
import { OtpService } from './otp.service.js';
import { BlocklistService } from './blocklist.service.js';
import { FakeOtpDeliveryProvider } from './otp-delivery.provider.js';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [AuthController],
  providers: [
    RegistrationService,
    OtpService,
    BlocklistService,
    {
      provide: 'IOtpDeliveryProvider',
      useClass: FakeOtpDeliveryProvider,
    },
  ],
  exports: [OtpService, BlocklistService, RegistrationService],
})
export class AuthModule {}

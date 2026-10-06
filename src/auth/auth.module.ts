import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../database/database.module.js';
import { AuthController } from './auth.controller.js';
import { PoliciesController } from './policies.controller.js';
import { RegistrationService } from './registration.service.js';
import { OtpService } from './otp.service.js';
import { BlocklistService } from './blocklist.service.js';
import { SessionService } from './session.service.js';
import { LoginService } from './login.service.js';
import { ProfileService } from './profile.service.js';
import { AccountService } from './account.service.js';
import { NotificationPreferenceService } from './notification-preference.service.js';
import { BlockService } from './block.service.js';
import { ConsentService } from './consent.service.js';
import { PolicyService } from './policy.service.js';
import { DeviceService } from './device.service.js';
import { FakeOtpDeliveryProvider } from './otp-delivery.provider.js';
import { ConsumerAuthGuard } from './guards/consumer-auth.guard.js';
import { AccountStatusGuard } from './guards/account-status.guard.js';
import { RestrictionGuard } from './guards/restriction.guard.js';
import { PolicyAcceptanceGuard } from './guards/policy-acceptance.guard.js';
import { AuthorizationHelper } from './helpers/authorization.helper.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),
        signOptions: {
          expiresIn: config.getOrThrow<number>('jwt.accessTokenTtl'),
        },
      }),
    }),
  ],
  controllers: [AuthController, PoliciesController],
  providers: [
    RegistrationService,
    OtpService,
    BlocklistService,
    SessionService,
    LoginService,
    ProfileService,
    AccountService,
    NotificationPreferenceService,
    BlockService,
    ConsentService,
    PolicyService,
    DeviceService,
    ConsumerAuthGuard,
    AccountStatusGuard,
    RestrictionGuard,
    PolicyAcceptanceGuard,
    AuthorizationHelper,
    {
      provide: 'IOtpDeliveryProvider',
      useClass: FakeOtpDeliveryProvider,
    },
  ],
  exports: [
    OtpService,
    BlocklistService,
    RegistrationService,
    SessionService,
    LoginService,
    ProfileService,
    AccountService,
    NotificationPreferenceService,
    BlockService,
    ConsentService,
    PolicyService,
    DeviceService,
    ConsumerAuthGuard,
    AccountStatusGuard,
    RestrictionGuard,
    PolicyAcceptanceGuard,
    AuthorizationHelper,
  ],
})
export class AuthModule {}

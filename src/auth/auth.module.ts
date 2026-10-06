import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../database/database.module.js';
import { AuthController } from './auth.controller.js';
import { RegistrationService } from './registration.service.js';
import { OtpService } from './otp.service.js';
import { BlocklistService } from './blocklist.service.js';
import { SessionService } from './session.service.js';
import { LoginService } from './login.service.js';
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
  controllers: [AuthController],
  providers: [
    RegistrationService,
    OtpService,
    BlocklistService,
    SessionService,
    LoginService,
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
    ConsumerAuthGuard,
    AccountStatusGuard,
    RestrictionGuard,
    PolicyAcceptanceGuard,
    AuthorizationHelper,
  ],
})
export class AuthModule {}

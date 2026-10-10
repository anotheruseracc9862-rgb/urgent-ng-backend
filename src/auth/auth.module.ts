import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module.js';
import { AuthController } from './auth.controller.js';
import { MeController } from './me.controller.js';
import { UsersController } from './users.controller.js';
import { AuthAuditService } from './auth-audit.service.js';
import { PasswordService } from './password.service.js';
import { OtpService } from './otp.service.js';
import { BlocklistService } from './blocklist.service.js';
import { RegistrationService } from './registration.service.js';
import { SessionService } from './session.service.js';
import { LoginService } from './login.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { RestrictionService } from './restriction.service.js';
import { PolicyService } from './policy.service.js';
import { ConsentService } from './consent.service.js';
import { ProfileService } from './profile.service.js';
import { AccountService, DELETION_BLOCKERS, type DeletionBlocker } from './account.service.js';
import { BlockService } from './block.service.js';
import { DeviceService } from './device.service.js';
import { NotificationPreferenceService } from './notification-preference.service.js';
import { ConsumerAuthGuard } from './guards/consumer-auth.guard.js';
import { AccountStatusGuard } from './guards/account-status.guard.js';
import { RestrictionGuard } from './guards/restriction.guard.js';
import { PolicyAcceptanceGuard } from './guards/policy-acceptance.guard.js';

/**
 * Consumer identity and access (Backend PRD sections 9 and 10).
 *
 * Other modules that protect routes with `@ConsumerAuth()` import this module: the
 * guards are exported together with the services they depend on.
 * Signing keys are passed per call (SessionService), so this module needs no default secret.
 */
@Module({
  imports: [AuditModule, JwtModule.register({})],
  controllers: [AuthController, MeController, UsersController],
  providers: [
    AuthAuditService,
    PasswordService,
    OtpService,
    BlocklistService,
    RegistrationService,
    SessionService,
    LoginService,
    PasswordResetService,
    RestrictionService,
    PolicyService,
    ConsentService,
    ProfileService,
    AccountService,
    // One shared list: modules that own something a user can still depend on push a blocker here at startup.
    { provide: DELETION_BLOCKERS, useFactory: (): DeletionBlocker[] => [] },
    BlockService,
    DeviceService,
    NotificationPreferenceService,
    ConsumerAuthGuard,
    AccountStatusGuard,
    RestrictionGuard,
    PolicyAcceptanceGuard,
  ],
  exports: [
    AuthAuditService,
    PasswordService,
    OtpService,
    BlocklistService,
    SessionService,
    RestrictionService,
    PolicyService,
    ConsentService,
    ProfileService,
    AccountService,
    DELETION_BLOCKERS,
    BlockService,
    DeviceService,
    NotificationPreferenceService,
    ConsumerAuthGuard,
    AccountStatusGuard,
    RestrictionGuard,
    PolicyAcceptanceGuard,
  ],
})
export class AuthModule {}

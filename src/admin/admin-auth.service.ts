import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  ACCOUNT_LOCKED,
  AUTH_REQUIRED,
  INVALID_CREDENTIALS,
  MFA_INVALID,
  RESOURCE_CONFLICT,
} from '../common/constants/error-codes.js';
import { decrypt, encrypt } from '../common/utils/crypto.helper.js';
import { generateTotpSecret, totpUri, verifyTotp } from '../common/utils/totp.js';
import { PasswordService } from '../auth/password.service.js';
import { AdminUserService, type AdminView } from './admin-user.service.js';
import { AdminSessionService, type AdminTokenPair } from './admin-session.service.js';
import { AdminAuthEventService, type AdminRequestContext } from './admin-auth-event.service.js';

export type AdminLoginResult =
  | { status: 'MFA_REQUIRED' | 'MFA_ENROLMENT_REQUIRED'; mfaToken: string }
  | { status: 'AUTHENTICATED'; admin: AdminView; tokens: AdminTokenPair };

/**
 * Admin authentication (Backend PRD 24.1).
 *
 *   1. login: email + password. Never returns tokens. Answers with a short-lived MFA token
 *      and which step is next: MFA_REQUIRED (enrolled) or MFA_ENROLMENT_REQUIRED (first login).
 *   2. mfa/enrol (first login only): returns the TOTP secret and otpauth URI.
 *   3. mfa/verify: a valid TOTP code completes the login and creates the session.
 *
 * TOTP is mandatory for every admin. A code is accepted once only (replay protection).
 * Wrong passwords and wrong codes share one failed-login counter and lockout. Every
 * outcome is written to admin_auth_events. An unknown email, a wrong password and a
 * non-active admin all answer INVALID_CREDENTIALS after the same amount of work.
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admins: AdminUserService,
    private readonly sessions: AdminSessionService,
    private readonly passwords: PasswordService,
    private readonly events: AdminAuthEventService,
    private readonly businessConfig: BusinessConfigService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async login(email: string, password: string, ctx: AdminRequestContext): Promise<AdminLoginResult> {
    const normalised = email.trim().toLowerCase();
    const admin = await this.admins.findByEmail(normalised);
    const passwordValid = await this.passwords.verify(admin?.passwordHash, password);

    if (admin) {
      const lock = await this.lockState(admin.id);
      if (lock.locked) {
        await this.events.record({ event: 'LOGIN_FAILED', adminId: admin.id, email: normalised, reason: 'LOCKED', ctx });
        throw DomainException.of(ACCOUNT_LOCKED, { details: { retryAfterSeconds: lock.retryAfterSeconds } });
      }
    }

    if (!admin || !passwordValid || admin.status !== 'ACTIVE') {
      if (admin) {
        await this.recordFailure(admin.id);
      }
      await this.events.record({
        event: 'LOGIN_FAILED',
        adminId: admin?.id,
        email: normalised,
        reason: !admin ? 'UNKNOWN_ADMIN' : !passwordValid ? 'WRONG_PASSWORD' : `STATUS_${admin.status}`,
        ctx,
      });
      throw DomainException.of(INVALID_CREDENTIALS);
    }

    if (!this.mfaRequired()) {
      // Temporary switch (ADMIN_MFA_REQUIRED=false): password alone completes the login. The TOTP
      // flow below stays intact and returns as soon as the switch is removed.
      return { status: 'AUTHENTICATED', ...(await this.completeLogin(admin.id, admin.email, ctx)) };
    }

    return {
      status: admin.mfaEnabled ? 'MFA_REQUIRED' : 'MFA_ENROLMENT_REQUIRED',
      mfaToken: await this.sessions.signMfaToken(admin.id),
    };
  }

  /** MFA is on unless ADMIN_MFA_REQUIRED is explicitly "false". */
  private mfaRequired(): boolean {
    return this.config.get<string>('ADMIN_MFA_REQUIRED') !== 'false';
  }

  private async completeLogin(adminId: string, email: string, ctx: AdminRequestContext): Promise<{ admin: AdminView; tokens: AdminTokenPair }> {
    await this.prisma.$executeRaw`
      UPDATE admins SET failed_login_count = 0, first_failed_login_at = NULL, locked_until = NULL, last_login_at = now()
      WHERE id = ${adminId}::uuid
    `;
    const tokens = await this.sessions.create(adminId, ctx);
    await this.events.record({ event: 'LOGIN_SUCCESS', adminId, email, ctx });
    return { admin: await this.admins.view(adminId), tokens };
  }

  /** First login: create (or re-issue) the TOTP secret. Refused once MFA is enabled. */
  async startEnrolment(mfaToken: string): Promise<{ secret: string; otpauthUri: string }> {
    const adminId = await this.sessions.verifyMfaToken(mfaToken);
    const admin = await this.admins.findById(adminId);
    if (!admin || admin.status !== 'ACTIVE') {
      throw DomainException.of(AUTH_REQUIRED);
    }
    if (admin.mfaEnabled) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'Two-factor authentication is already set up.' });
    }

    const secret = generateTotpSecret();
    await this.prisma.$executeRaw`
      UPDATE admins SET mfa_secret_encrypted = ${this.encryptSecret(secret, admin.id)}
      WHERE id = ${admin.id}::uuid AND mfa_enabled = false
    `;
    return { secret, otpauthUri: totpUri(secret, admin.email) };
  }

  /** Check the TOTP code. On success the login completes (and MFA becomes enabled on the first success). */
  async verifyMfa(mfaToken: string, code: string, ctx: AdminRequestContext): Promise<{ admin: AdminView; tokens: AdminTokenPair }> {
    const adminId = await this.sessions.verifyMfaToken(mfaToken);
    const admin = await this.admins.findById(adminId);
    if (!admin || admin.status !== 'ACTIVE' || !admin.mfaSecretEncrypted) {
      throw DomainException.of(AUTH_REQUIRED);
    }

    const lock = await this.lockState(admin.id);
    if (lock.locked) {
      await this.events.record({ event: 'MFA_FAILED', adminId: admin.id, email: admin.email, reason: 'LOCKED', ctx });
      throw DomainException.of(ACCOUNT_LOCKED, { details: { retryAfterSeconds: lock.retryAfterSeconds } });
    }

    const step = verifyTotp(this.decryptSecret(admin.mfaSecretEncrypted, admin.id), code);
    if (step === null || !(await this.claimStep(admin.id, step))) {
      await this.recordFailure(admin.id);
      await this.events.record({ event: 'MFA_FAILED', adminId: admin.id, email: admin.email, reason: 'WRONG_CODE', ctx });
      throw DomainException.of(MFA_INVALID);
    }

    if (!admin.mfaEnabled) {
      await this.prisma.$executeRaw`UPDATE admins SET mfa_enabled = true WHERE id = ${admin.id}::uuid`;
      await this.events.record({ event: 'MFA_ENROLLED', adminId: admin.id, email: admin.email, ctx });
    }
    return this.completeLogin(admin.id, admin.email, ctx);
  }

  async refresh(refreshToken: string, ctx: AdminRequestContext): Promise<AdminTokenPair> {
    return this.sessions.refresh(refreshToken, ctx);
  }

  async logout(familyId: string, adminId: string, ctx: AdminRequestContext): Promise<void> {
    await this.sessions.revokeFamily(familyId);
    await this.events.record({ event: 'LOGOUT', adminId, ctx });
  }

  /** A TOTP step is accepted once per admin. Fails closed if Redis cannot be reached. */
  private async claimStep(adminId: string, step: number): Promise<boolean> {
    try {
      return (await this.redis.set(`admin:totp:${adminId}:${step}`, '1', 'EX', 120, 'NX')) === 'OK';
    } catch (error) {
      this.logger.error(`TOTP replay store unavailable, refusing the code: ${String(error)}`);
      return false;
    }
  }

  private async lockState(adminId: string): Promise<{ locked: boolean; retryAfterSeconds: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ locked: boolean; retry: number }>>`
      SELECT (locked_until IS NOT NULL AND locked_until > now()) AS locked,
             COALESCE(ceil(extract(epoch FROM (locked_until - now()))), 0)::int AS retry
      FROM admins WHERE id = ${adminId}::uuid
    `;
    return { locked: rows[0]?.locked ?? false, retryAfterSeconds: Math.max(rows[0]?.retry ?? 0, 0) };
  }

  /** Atomic failed-login count inside a window, then lock when the limit is reached. */
  private async recordFailure(adminId: string): Promise<void> {
    const [maxFailures, windowMinutes] = await Promise.all([
      this.businessConfig.get('LOGIN_LOCKOUT_FAILURES'),
      this.businessConfig.get('LOGIN_LOCKOUT_WINDOW_MINUTES'),
    ]);
    await this.prisma.$executeRaw`
      UPDATE admins SET
        failed_login_count = CASE
          WHEN first_failed_login_at IS NULL OR first_failed_login_at < now() - make_interval(mins => ${windowMinutes}::int)
          THEN 1 ELSE failed_login_count + 1 END,
        first_failed_login_at = CASE
          WHEN first_failed_login_at IS NULL OR first_failed_login_at < now() - make_interval(mins => ${windowMinutes}::int)
          THEN now() ELSE first_failed_login_at END
      WHERE id = ${adminId}::uuid
    `;
    const locked = await this.prisma.$executeRaw`
      UPDATE admins SET locked_until = now() + make_interval(mins => ${windowMinutes}::int)
      WHERE id = ${adminId}::uuid AND failed_login_count >= ${maxFailures}
        AND (locked_until IS NULL OR locked_until <= now())
    `;
    if (locked > 0) {
      await this.events.record({ event: 'LOCKOUT', adminId, ctx: {} });
    }
  }

  private encryptSecret(secret: string, adminId: string): string {
    return encrypt(secret, this.config.getOrThrow<string>('security.dataEncryptionKey'), { aad: `admin:${adminId}` });
  }

  private decryptSecret(ciphertext: string, adminId: string): string {
    return decrypt(ciphertext, this.config.getOrThrow<string>('security.dataEncryptionKey'), { aad: `admin:${adminId}` });
  }
}

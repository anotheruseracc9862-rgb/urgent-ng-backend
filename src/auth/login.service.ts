import { Injectable } from '@nestjs/common';
import type { UserStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  ACCOUNT_LOCKED,
  ACCOUNT_SUSPENDED,
  INVALID_CREDENTIALS,
} from '../common/constants/error-codes.js';
import { AuthAuditService, type RequestContext } from './auth-audit.service.js';
import { PasswordService } from './password.service.js';
import { RestrictionService } from './restriction.service.js';
import { SessionService, type TokenPair } from './session.service.js';
import { maskIdentifier, type Identifier } from './identifier.js';

export interface LoginResult {
  userId: string;
  status: UserStatus;
  tokens: TokenPair;
}

/**
 * Login (Backend PRD 9.3).
 *
 * - The password is always verified (a dummy hash when the account does not exist),
 *   and every failure answers INVALID_CREDENTIALS, so neither the error nor the
 *   response time reveals whether an account exists or what state it is in.
 * - Failed logins are counted atomically in the database inside a window
 *   (LOGIN_LOCKOUT_FAILURES in LOGIN_LOCKOUT_WINDOW_MINUTES); reaching the limit
 *   locks the account for one window. Only an account that really exists can show
 *   ACCOUNT_LOCKED.
 * - DEACTIVATED and DELETION_PENDING users may log in: they need a session to
 *   reactivate or cancel deletion (Backend PRD 9.5). What they may do afterwards is
 *   decided by the account-status guard. An active ACCOUNT_LOGIN restriction blocks login.
 */
@Injectable()
export class LoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly restrictions: RestrictionService,
    private readonly businessConfig: BusinessConfigService,
    private readonly audit: AuthAuditService,
  ) {}

  async login(identifier: Identifier, password: string, ctx: RequestContext = {}): Promise<LoginResult> {
    const user = await this.prisma.client.user.findFirst({
      where: identifier.kind === 'phone' ? { phoneE164: identifier.value } : { email: identifier.value },
      select: { id: true, passwordHash: true, status: true },
    });

    const passwordValid = await this.passwords.verify(user?.passwordHash, password);

    if (user) {
      const lock = await this.lockState(user.id);
      if (lock.locked) {
        await this.audit.record({
          action: 'auth.login.blocked_locked',
          actorId: user.id,
          ctx,
        });
        throw DomainException.of(ACCOUNT_LOCKED, {
          details: { retryAfterSeconds: lock.retryAfterSeconds },
        });
      }
    }

    if (!user || !passwordValid) {
      await this.recordFailure(user?.id, identifier, ctx);
      throw DomainException.of(INVALID_CREDENTIALS);
    }

    const loginRestriction = await this.restrictions.findActive(user.id, 'ACCOUNT_LOGIN');
    if (loginRestriction) {
      await this.audit.record({ action: 'auth.login.blocked_restricted', actorId: user.id, ctx });
      throw DomainException.of(ACCOUNT_SUSPENDED, {
        details: { endsAt: loginRestriction.endsAt },
      });
    }

    await this.prisma.$executeRaw`
      UPDATE users
      SET failed_login_count = 0, first_failed_login_at = NULL, locked_until = NULL, last_login_at = now()
      WHERE id = ${user.id}::uuid
    `;

    const tokens = await this.sessions.create(user.id, ctx);
    await this.audit.record({
      action: 'auth.login',
      actorId: user.id,
      metadata: { identifier: maskIdentifier(identifier.value) },
      ctx,
    });

    return { userId: user.id, status: user.status, tokens };
  }

  private async lockState(userId: string): Promise<{ locked: boolean; retryAfterSeconds: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ locked: boolean; retry: number }>>`
      SELECT (locked_until IS NOT NULL AND locked_until > now()) AS locked,
             COALESCE(ceil(extract(epoch FROM (locked_until - now()))), 0)::int AS retry
      FROM users WHERE id = ${userId}::uuid
    `;
    return { locked: rows[0]?.locked ?? false, retryAfterSeconds: Math.max(rows[0]?.retry ?? 0, 0) };
  }

  /**
   * Count a failed login. Both statements are single atomic updates, so parallel
   * guesses cannot bypass the limit: PostgreSQL re-reads the row after waiting for the lock.
   */
  private async recordFailure(
    userId: string | undefined,
    identifier: Identifier,
    ctx: RequestContext,
  ): Promise<void> {
    if (!userId) {
      await this.audit.record({
        action: 'auth.login.failed',
        reasonCode: 'UNKNOWN_ACCOUNT',
        metadata: { identifier: maskIdentifier(identifier.value) },
        ctx,
      });
      return;
    }

    const [maxFailures, windowMinutes] = await Promise.all([
      this.businessConfig.get('LOGIN_LOCKOUT_FAILURES'),
      this.businessConfig.get('LOGIN_LOCKOUT_WINDOW_MINUTES'),
    ]);

    const counted = await this.prisma.$queryRaw<Array<{ count: number }>>`
      UPDATE users SET
        failed_login_count = CASE
          WHEN first_failed_login_at IS NULL
            OR first_failed_login_at < now() - make_interval(mins => ${windowMinutes}::int)
          THEN 1 ELSE failed_login_count + 1 END,
        first_failed_login_at = CASE
          WHEN first_failed_login_at IS NULL
            OR first_failed_login_at < now() - make_interval(mins => ${windowMinutes}::int)
          THEN now() ELSE first_failed_login_at END
      WHERE id = ${userId}::uuid
      RETURNING failed_login_count AS count
    `;

    const locked = await this.prisma.$executeRaw`
      UPDATE users SET locked_until = now() + make_interval(mins => ${windowMinutes}::int)
      WHERE id = ${userId}::uuid
        AND failed_login_count >= ${maxFailures}
        AND (locked_until IS NULL OR locked_until <= now())
    `;

    await this.audit.record({
      action: 'auth.login.failed',
      actorId: userId,
      reasonCode: 'WRONG_PASSWORD',
      metadata: { failedCount: counted[0]?.count },
      ctx,
    });
    if (locked > 0) {
      await this.audit.record({ action: 'auth.login.locked_out', actorId: userId, ctx });
    }
  }
}

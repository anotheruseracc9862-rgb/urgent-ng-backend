import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuthAuditService, type RequestContext } from './auth-audit.service.js';
import { OtpPurpose, OtpService } from './otp.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { OTP_INVALID } from '../common/constants/error-codes.js';
import type { Identifier } from './identifier.js';

/**
 * Password reset by OTP (Backend PRD 9.2).
 *
 * `forgot` gives the same answer and the same rate-limit behaviour whether or not the
 * account exists. `reset` clears any login lockout and ends every session.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuthAuditService,
  ) {}

  async forgot(identifier: Identifier, ctx: RequestContext = {}): Promise<void> {
    const user = await this.prisma.client.user.findFirst({
      where: identifier.kind === 'phone' ? { phoneE164: identifier.value } : { email: identifier.value },
      select: { id: true },
    });
    await this.otp.send(identifier, OtpPurpose.PASSWORD_RESET, ctx, { deliver: Boolean(user) });
  }

  async reset(
    identifier: Identifier,
    code: string,
    newPassword: string,
    ctx: RequestContext = {},
  ): Promise<void> {
    await this.otp.verify(identifier, code, OtpPurpose.PASSWORD_RESET, ctx);

    const user = await this.prisma.client.user.findFirst({
      where: identifier.kind === 'phone' ? { phoneE164: identifier.value } : { email: identifier.value },
      select: { id: true },
    });
    if (!user) {
      // Only reachable if the account vanished between the code and now.
      throw DomainException.of(OTP_INVALID);
    }

    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$executeRaw`
      UPDATE users
      SET password_hash = ${passwordHash}, failed_login_count = 0,
          first_failed_login_at = NULL, locked_until = NULL
      WHERE id = ${user.id}::uuid
    `;
    await this.sessions.revokeAllForUser(user.id);

    await this.audit.record({ action: 'auth.password.reset', actorId: user.id, ctx });
  }
}

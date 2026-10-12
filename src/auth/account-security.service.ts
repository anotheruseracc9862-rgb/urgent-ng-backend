import { Injectable } from '@nestjs/common';
import { AuditActorType, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  IDENTIFIER_TAKEN,
  INVALID_CREDENTIALS,
  REGISTRATION_BLOCKED,
  RESOURCE_NOT_FOUND,
  VALIDATION_ERROR,
} from '../common/constants/error-codes.js';
import { BlocklistService } from './blocklist.service.js';
import { OtpPurpose, OtpService } from './otp.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { GoogleAuthService, NO_PASSWORD_PREFIX } from './google-auth.service.js';
import { AuthAuditService, type RequestContext } from './auth-audit.service.js';
import { maskIdentifier, singleIdentifier, type Identifier } from './identifier.js';

/**
 * Changes a signed-in user makes to how they sign in: the password, and the phone number or email
 * of the account (demo profile settings). Each change asks for the current password, so a stolen
 * session alone cannot take the account over, and tells the user afterwards.
 */
@Injectable()
export class AccountSecurityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly otp: OtpService,
    private readonly blocklist: BlocklistService,
    private readonly audit: AuthAuditService,
    private readonly auditLog: AuditService,
    private readonly outbox: OutboxService,
    private readonly google: GoogleAuthService,
  ) {}

  /**
   * Change the password. The new one must differ from the current one. Every other session of the
   * user ends; this one stays signed in. A lockout or failed-login count is cleared.
   */
  async changePassword(
    userId: string,
    currentSessionId: string,
    proof: { currentPassword?: string; googleIdToken?: string },
    newPassword: string,
    ctx: RequestContext = {},
  ): Promise<void> {
    const user = await this.requireUser(userId);
    await this.requireProof(user.id, user.passwordHash, proof, 'auth.password.change_failed', ctx);

    if (proof.currentPassword === newPassword) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Choose a password you have not used just now.',
        details: { field: 'newPassword' },
      });
    }

    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE users
        SET password_hash = ${passwordHash}, failed_login_count = 0, first_failed_login_at = NULL, locked_until = NULL
        WHERE id = ${userId}::uuid
      `;
      await this.outbox.add(tx, {
        eventType: 'account.password_changed',
        aggregateType: 'user',
        aggregateId: userId,
        payload: { userId },
      });
    });
    await this.sessions.revokeAllForUser(userId, currentSessionId);
    await this.audit.record({ action: 'auth.password.changed', actorId: userId, ctx });
  }

  /**
   * Step 1 of adding or changing a phone number or email: check the password and send a code to
   * the NEW value. Nothing changes until `verifyContact` accepts the code.
   */
  async requestContactChange(
    userId: string,
    input: { currentPassword?: string; googleIdToken?: string; phone?: string; email?: string },
    ctx: RequestContext = {},
  ): Promise<{ sentTo: string }> {
    const identifier = singleIdentifier(input);
    const user = await this.requireUser(userId);
    await this.requireProof(user.id, user.passwordHash, input, 'auth.contact.change_failed', ctx);

    const blocked =
      identifier.kind === 'phone'
        ? await this.blocklist.isPhoneBlocked(identifier.value)
        : await this.blocklist.isEmailBlocked(identifier.value);
    if (blocked) {
      throw DomainException.of(REGISTRATION_BLOCKED);
    }

    const current = await this.prisma.client.user.findUniqueOrThrow({
      where: { id: userId },
      select: { phoneE164: true, phoneVerifiedAt: true, email: true, emailVerifiedAt: true },
    });
    const same = identifier.kind === 'phone' ? current.phoneE164 === identifier.value : current.email === identifier.value;
    const verified = identifier.kind === 'phone' ? current.phoneVerifiedAt : current.emailVerifiedAt;
    if (same && verified) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'That is already your verified contact.' });
    }
    if (await this.heldByAnother(identifier, userId)) {
      throw DomainException.of(IDENTIFIER_TAKEN);
    }

    await this.otp.send(identifier, OtpPurpose.CONTACT_CHANGE, ctx);
    await this.audit.record({
      action: 'auth.contact.change_requested',
      actorId: userId,
      metadata: { kind: identifier.kind, identifier: maskIdentifier(identifier.value) },
      ctx,
    });
    return { sentTo: maskIdentifier(identifier.value) };
  }

  /** Step 2: the code proves the person holds the new value. The account then uses it. */
  async verifyContact(
    userId: string,
    input: { phone?: string; email?: string; code: string },
    ctx: RequestContext = {},
  ): Promise<{ kind: Identifier['kind']; value: string }> {
    const identifier = singleIdentifier(input);
    await this.requireUser(userId);
    await this.otp.verify(identifier, input.code, OtpPurpose.CONTACT_CHANGE, ctx);

    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { phoneE164: true, email: true },
        });
        if (identifier.kind === 'phone') {
          await tx.$executeRaw`
            UPDATE users SET phone_e164 = ${identifier.value}, phone_verified_at = now() WHERE id = ${userId}::uuid
          `;
        } else {
          await tx.$executeRaw`
            UPDATE users SET email = ${identifier.value}, email_verified_at = now() WHERE id = ${userId}::uuid
          `;
        }
        const previous = identifier.kind === 'phone' ? before.phoneE164 : before.email;
        await this.outbox.add(tx, {
          eventType: 'account.contact_changed',
          aggregateType: 'user',
          aggregateId: userId,
          payload: { userId, kind: identifier.kind, replaced: previous !== null },
        });
        await this.auditLog.recordInTransaction(tx, {
          actorType: AuditActorType.USER,
          actorId: userId,
          action: 'account.contact_changed',
          entityType: 'user',
          entityId: userId,
          metadata: {
            kind: identifier.kind,
            from: previous ? maskIdentifier(previous) : null,
            to: maskIdentifier(identifier.value),
          },
          requestId: ctx.requestId,
          ip: ctx.ip,
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw DomainException.of(IDENTIFIER_TAKEN);
      }
      throw error;
    }
    return { kind: identifier.kind, value: maskIdentifier(identifier.value) };
  }

  // ---- internals ----

  private async requireUser(userId: string): Promise<{ id: string; passwordHash: string }> {
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });
    if (!user) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return user;
  }

  /**
   * An account with a password proves itself with it. An account created with Google has no
   * password: it proves itself with a fresh Google ID token for the linked Google account.
   */
  private async requireProof(
    userId: string,
    hash: string,
    proof: { currentPassword?: string; googleIdToken?: string },
    failedAction: string,
    ctx: RequestContext,
  ): Promise<void> {
    const hasNoPassword = hash.startsWith(NO_PASSWORD_PREFIX);
    let ok = false;
    if (hasNoPassword) {
      ok = proof.googleIdToken ? await this.google.confirmsUser(userId, proof.googleIdToken) : false;
    } else {
      ok = proof.currentPassword ? await this.passwords.verify(hash, proof.currentPassword) : false;
    }
    if (!ok) {
      await this.audit.record({ action: failedAction, actorId: userId, ctx });
      throw DomainException.of(INVALID_CREDENTIALS, {
        message: hasNoPassword ? 'Confirm with your Google account.' : 'The current password is not correct.',
      });
    }
  }

  private async heldByAnother(identifier: Identifier, userId: string): Promise<boolean> {
    const holder = await this.prisma.client.user.findFirst({
      where: {
        id: { not: userId },
        ...(identifier.kind === 'phone' ? { phoneE164: identifier.value } : { email: identifier.value }),
      },
      select: { id: true },
    });
    return holder !== null;
  }
}

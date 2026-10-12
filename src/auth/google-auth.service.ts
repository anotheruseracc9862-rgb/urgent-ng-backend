import { OutboxService } from '../queue/outbox.service.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConsentType, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  ACCOUNT_SUSPENDED,
  GOOGLE_SIGNUP_REQUIRED,
  IDENTIFIER_TAKEN,
  INVALID_CREDENTIALS,
  REGISTRATION_BLOCKED,
  SIGN_IN_PROVIDER_UNAVAILABLE,
  VALIDATION_ERROR,
} from '../common/constants/error-codes.js';
import {
  GOOGLE_IDENTITY_PROVIDER,
  type GoogleIdentity,
  type IGoogleIdentityProvider,
} from '../common/providers/google-identity.provider.js';
import { ProviderError } from '../common/providers/provider.error.js';
import { BlocklistService } from './blocklist.service.js';
import { PolicyService } from './policy.service.js';
import { RestrictionService } from './restriction.service.js';
import { SessionService } from './session.service.js';
import { AuthAuditService, type RequestContext } from './auth-audit.service.js';
import { REQUIRED_CONSENTS } from './registration.service.js';
import type { LoginResult } from './login.service.js';
import { maskIdentifier } from './identifier.js';

/** The prefix of the password hash of an account that has no password of its own (Google only). */
export const NO_PASSWORD_PREFIX = 'oauth:';

export interface GoogleSignInInput {
  idToken: string;
  /** Needed only when the sign-in creates a new account. */
  consents?: Array<{ type: ConsentType; version: string }>;
  homeArea?: string;
}

/**
 * Sign in with Google.
 *
 * - The ID token is verified by the provider; it is never stored.
 * - An account already linked to the Google subject signs in.
 * - Otherwise a verified Google email that matches an existing account links to it (only a
 *   verified email may link, so nobody can take over an account with an unverified claim).
 * - Otherwise a new account is created, once the required policies are accepted. It has no
 *   password until the user sets one; its email is verified by Google.
 * - The same restrictions apply as for a password login.
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(GOOGLE_IDENTITY_PROVIDER) private readonly google: IGoogleIdentityProvider,
    private readonly blocklist: BlocklistService,
    private readonly policies: PolicyService,
    private readonly restrictions: RestrictionService,
    private readonly sessions: SessionService,
    private readonly audit: AuthAuditService,
    private readonly outbox: OutboxService,
  ) {}

  async signIn(input: GoogleSignInInput, ctx: RequestContext = {}): Promise<LoginResult & { isNewAccount: boolean }> {
    const identity = await this.verifyToken(input.idToken);

    const linked = await this.prisma.client.user.findFirst({
      where: { googleSubject: identity.subject },
      select: { id: true, status: true },
    });
    if (linked) {
      return this.issue(linked.id, linked.status, false, ctx);
    }

    if (!identity.email || !identity.emailVerified) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Your Google account has no verified email address.',
        details: { reason: 'GOOGLE_EMAIL_NOT_VERIFIED' },
      });
    }

    const byEmail = await this.prisma.client.user.findFirst({
      where: { email: identity.email },
      select: { id: true, status: true, googleSubject: true },
    });
    if (byEmail) {
      if (byEmail.googleSubject && byEmail.googleSubject !== identity.subject) {
        throw DomainException.of(IDENTIFIER_TAKEN, { message: 'This email is linked to a different Google account.' });
      }
      await this.prisma.$executeRaw`
        UPDATE users
        SET google_subject = ${identity.subject}, email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = ${byEmail.id}::uuid AND google_subject IS NULL
      `;
      await this.audit.record({
        action: 'auth.google.linked',
        actorId: byEmail.id,
        metadata: { email: maskIdentifier(identity.email) },
        ctx,
      });
      return this.issue(byEmail.id, byEmail.status, false, ctx);
    }

    return this.createAccount(identity, identity.email, input, ctx);
  }

  /**
   * Check a Google ID token for a signed-in user who has no password: it must belong to the
   * Google account linked to this user. Used to confirm sensitive changes in place of a password.
   */
  async confirmsUser(userId: string, idToken: string): Promise<boolean> {
    const identity = await this.verifyToken(idToken);
    const user = await this.prisma.client.user.findFirst({ where: { id: userId }, select: { googleSubject: true } });
    return Boolean(user?.googleSubject) && user?.googleSubject === identity.subject;
  }

  // ---- internals ----

  private async verifyToken(idToken: string): Promise<GoogleIdentity> {
    let identity: GoogleIdentity | null;
    try {
      identity = await this.google.verifyIdToken(idToken);
    } catch (error) {
      if (error instanceof ProviderError) {
        this.logger.warn(`Google sign-in unavailable: ${error.message}`);
        throw DomainException.of(SIGN_IN_PROVIDER_UNAVAILABLE);
      }
      throw error;
    }
    if (!identity) {
      throw DomainException.of(INVALID_CREDENTIALS, { message: 'The Google sign-in could not be verified.' });
    }
    return identity;
  }

  private async createAccount(
    identity: GoogleIdentity,
    email: string,
    input: GoogleSignInInput,
    ctx: RequestContext,
  ): Promise<LoginResult & { isNewAccount: boolean }> {
    if (!input.consents || input.consents.length === 0) {
      throw DomainException.of(GOOGLE_SIGNUP_REQUIRED, { details: { email, name: identity.name } });
    }
    const accepted = new Set(input.consents.map((c) => c.type));
    const missing = REQUIRED_CONSENTS.filter((type) => !accepted.has(type));
    if (missing.length > 0) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'All required policies must be accepted.',
        details: { missingConsents: missing },
      });
    }
    if (await this.blocklist.isEmailBlocked(email)) {
      throw DomainException.of(REGISTRATION_BLOCKED);
    }
    for (const consent of input.consents) {
      if (!(await this.policies.findPublished(consent.type, consent.version))) {
        throw DomainException.of(VALIDATION_ERROR, { message: 'A policy version is not valid.', details: { consent } });
      }
    }

    const name = (identity.name ?? email.split('@')[0]).trim().slice(0, 100) || 'Urgent user';
    const [firstName, ...rest] = name.split(/\s+/);
    const lastName = rest.join(' ') || firstName;
    // No usable password: the hash is a random value that no password can match.
    const passwordHash = `${NO_PASSWORD_PREFIX}${randomBytes(24).toString('hex')}`;

    let userId: string;
    try {
      userId = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name,
            firstName,
            lastName,
            email,
            emailVerifiedAt: new Date(),
            googleSubject: identity.subject,
            passwordHash,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        await tx.profile.create({ data: { userId: user.id, homeArea: input.homeArea?.trim() || null } });
        await this.outbox.add(tx, {
          eventType: 'user.created',
          aggregateType: 'user',
          aggregateId: user.id,
          payload: { userId: user.id, method: 'GOOGLE' },
        });
        for (const consent of input.consents ?? []) {
          await tx.$executeRaw`
            INSERT INTO consent_records (user_id, consent_type, document_version, accepted_at, ip_address, user_agent)
            VALUES (${user.id}::uuid, ${consent.type}::"ConsentType", ${consent.version}, now(),
                    ${ctx.ip ?? null}::inet, ${ctx.userAgent ?? null})
          `;
        }
        return user.id;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw DomainException.of(IDENTIFIER_TAKEN);
      }
      throw error;
    }
    await this.audit.record({
      action: 'auth.google.registered',
      actorId: userId,
      metadata: { email: maskIdentifier(email) },
      ctx,
    });
    return this.issue(userId, 'ACTIVE', true, ctx);
  }

  private async issue(
    userId: string,
    status: LoginResult['status'],
    isNewAccount: boolean,
    ctx: RequestContext,
  ): Promise<LoginResult & { isNewAccount: boolean }> {
    const loginRestriction = await this.restrictions.findActive(userId, 'ACCOUNT_LOGIN');
    if (loginRestriction) {
      await this.audit.record({ action: 'auth.login.blocked_restricted', actorId: userId, ctx });
      throw DomainException.of(ACCOUNT_SUSPENDED, { details: { endsAt: loginRestriction.endsAt } });
    }
    await this.prisma.$executeRaw`
      UPDATE users SET failed_login_count = 0, first_failed_login_at = NULL, locked_until = NULL, last_login_at = now()
      WHERE id = ${userId}::uuid
    `;
    const tokens = await this.sessions.create(userId, ctx);
    await this.audit.record({ action: 'auth.login', actorId: userId, metadata: { method: 'google' }, ctx });
    return { userId, status, tokens, isNewAccount };
  }
}

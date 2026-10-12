import { Injectable, Logger } from '@nestjs/common';
import { ConsentType, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  IDENTIFIER_TAKEN,
  REGISTRATION_BLOCKED,
  RESOURCE_NOT_FOUND,
  VALIDATION_ERROR,
} from '../common/constants/error-codes.js';
import { BlocklistService } from './blocklist.service.js';
import { OtpPurpose, OtpService } from './otp.service.js';
import { PasswordService } from './password.service.js';
import { PolicyService } from './policy.service.js';
import { AuthAuditService, type RequestContext } from './auth-audit.service.js';
import { maskIdentifier, type Identifier } from './identifier.js';

export interface RegisterInput {
  name: string;
  phone?: string;
  email?: string;
  password: string;
  consents: Array<{ type: ConsentType; version: string }>;
  homeArea?: string;
}

export interface RegisterResult {
  userId: string;
  /** Where the verification code was sent (phone when both were given). */
  verifyVia: Identifier['kind'];
  otpSent: boolean;
}

/**
 * Policies every new account must accept (Backend PRD 9.2, 9.6). Location sharing and
 * marketing are optional consents and are never required.
 */
export const REQUIRED_CONSENTS: ConsentType[] = [
  ConsentType.TERMS_OF_SERVICE,
  ConsentType.PRIVACY_POLICY,
  ConsentType.SAFETY_POLICY,
  ConsentType.PROHIBITED_ITEMS_POLICY,
  ConsentType.OFFLINE_PAYMENT_TERMS,
];

/**
 * Registration and identifier verification (Backend PRD 9.2).
 *
 * - Cheap checks (shape, required consents, blocklist, policy versions) run before
 *   the expensive Argon2 hash.
 * - Phone and email are unique among live accounts. If the holder never verified
 *   anything and registered longer ago than an OTP lives, a new registration takes
 *   the identifier over (the stale account is soft-deleted), so nobody can squat
 *   someone else's number by registering it first.
 * - A registration race is resolved by the database unique indexes (IDENTIFIER_TAKEN).
 */
@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blocklist: BlocklistService,
    private readonly otp: OtpService,
    private readonly passwords: PasswordService,
    private readonly policies: PolicyService,
    private readonly businessConfig: BusinessConfigService,
    private readonly audit: AuthAuditService,
  ) {}

  async register(input: RegisterInput, ctx: RequestContext = {}): Promise<RegisterResult> {
    if (!input.phone && !input.email) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Provide a phone number or an email address.',
      });
    }

    const accepted = new Set(input.consents.map((consent) => consent.type));
    const missing = REQUIRED_CONSENTS.filter((type) => !accepted.has(type));
    if (missing.length > 0) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'All required policies must be accepted.',
        details: { missingConsents: missing },
      });
    }

    if (
      (input.phone && (await this.blocklist.isPhoneBlocked(input.phone))) ||
      (input.email && (await this.blocklist.isEmailBlocked(input.email)))
    ) {
      await this.audit.record({
        action: 'auth.register.blocked',
        metadata: { identifier: maskIdentifier((input.phone ?? input.email) as string) },
        ctx,
      });
      throw DomainException.of(REGISTRATION_BLOCKED);
    }

    for (const consent of input.consents) {
      const published = await this.policies.findPublished(consent.type, consent.version);
      if (!published) {
        throw DomainException.of(VALIDATION_ERROR, {
          message: 'A policy version is not valid.',
          details: { consent },
        });
      }
    }

    const passwordHash = await this.passwords.hash(input.password);
    const userId = await this.createAccount(input, passwordHash, ctx);

    const verifyVia: Identifier['kind'] = input.phone ? 'phone' : 'email';
    const identifier: Identifier = {
      kind: verifyVia,
      value: (input.phone ?? input.email) as string,
    };

    let otpSent = true;
    try {
      await this.otp.send(identifier, OtpPurpose.REGISTRATION, ctx);
    } catch (error) {
      otpSent = false;
      this.logger.warn(`Could not send the registration code to user ${userId}: ${String(error)}`);
    }

    await this.audit.record({
      action: 'auth.register',
      actorId: userId,
      metadata: { identifier: maskIdentifier(identifier.value), channel: verifyVia },
      ctx,
    });

    return { userId, verifyVia, otpSent };
  }

  /** Re-send the registration code. Always succeeds from the caller's view (no account probing). */
  async resend(identifier: Identifier, ctx: RequestContext = {}): Promise<void> {
    const user = await this.prisma.client.user.findFirst({
      where:
        identifier.kind === 'phone'
          ? { phoneE164: identifier.value, phoneVerifiedAt: null }
          : { email: identifier.value, emailVerifiedAt: null },
      select: { id: true },
    });
    await this.otp.send(identifier, OtpPurpose.REGISTRATION, ctx, { deliver: Boolean(user) });
  }

  /** Check the code, then mark the phone or email as verified. Returns the user id. */
  async verify(identifier: Identifier, code: string, ctx: RequestContext = {}): Promise<string> {
    await this.otp.verify(identifier, code, OtpPurpose.REGISTRATION, ctx);

    const column = identifier.kind === 'phone' ? Prisma.sql`phone_e164` : Prisma.sql`email`;
    const verified = identifier.kind === 'phone' ? Prisma.sql`phone_verified_at` : Prisma.sql`email_verified_at`;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE users SET ${verified} = COALESCE(${verified}, now())
      WHERE ${column} = ${identifier.value} AND deleted_at IS NULL
      RETURNING id
    `;
    if (rows.length === 0) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }

    await this.audit.record({
      action: 'auth.identifier.verified',
      actorId: rows[0].id,
      metadata: { channel: identifier.kind },
      ctx,
    });
    return rows[0].id;
  }

  private async createAccount(
    input: RegisterInput,
    passwordHash: string,
    ctx: RequestContext,
  ): Promise<string> {
    const otpMinutes = await this.businessConfig.get('OTP_TTL_MINUTES');
    const [firstName, ...rest] = input.name.trim().split(/\s+/);
    const lastName = rest.join(' ') || firstName;

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.releaseStaleUnverified(tx, input, otpMinutes);

        const user = await tx.user.create({
          data: {
            name: input.name.trim(),
            firstName,
            lastName,
            phoneE164: input.phone ?? null,
            email: input.email ?? null,
            passwordHash,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        await tx.profile.create({ data: { userId: user.id, homeArea: input.homeArea?.trim() || null } });

        for (const consent of input.consents) {
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
  }

  /**
   * Free an identifier held by an account that never verified anything and is older
   * than an OTP lifetime. A verified or recent account keeps it (the insert then
   * fails on the unique index and the caller gets IDENTIFIER_TAKEN).
   */
  private async releaseStaleUnverified(
    tx: Prisma.TransactionClient,
    input: RegisterInput,
    otpMinutes: number,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE users SET status = 'DELETED'::"UserStatus", deleted_at = now()
      WHERE deleted_at IS NULL
        AND phone_verified_at IS NULL AND email_verified_at IS NULL
        AND created_at < now() - make_interval(mins => ${otpMinutes}::int)
        AND (
          (${input.phone ?? null}::text IS NOT NULL AND phone_e164 = ${input.phone ?? null})
          OR (${input.email ?? null}::text IS NOT NULL AND email = ${input.email ?? null})
        )
    `;
  }
}

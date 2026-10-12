import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditActorType, type Prisma, type VerificationFailureReason } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { MediaService } from '../media/media.service.js';
import { PricingService } from '../config/pricing.service.js';
import { KYC_PROVIDER, type IKycProvider, type KycVerifyResult } from '../common/providers/kyc.provider.js';
import { STORAGE_PROVIDER, type IStorageProvider } from '../common/providers/storage.provider.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { hmacSign } from '../common/utils/crypto.helper.js';
import {
  FORBIDDEN,
  RATE_LIMITED,
  RESOURCE_CONFLICT,
  RESOURCE_NOT_FOUND,
  VALIDATION_ERROR,
  VERIFICATION_FEE_REQUIRED,
  VERIFICATION_PENDING,
} from '../common/constants/error-codes.js';
import type { RequestContext } from '../auth/auth-audit.service.js';
import { toAttemptView, VerificationStatusService, type AttemptView } from './verification-status.service.js';
import { isIdentityConflict } from './unique-violation.js';
import { displayStatus, type DisplayStatus } from './verification.state.js';
import type { GuarantorDto, IdDocumentDto, IdentityDetailsDto, VerificationSubmissionDto } from './verification.dto.js';

const MINIMUM_AGE_YEARS = 18;

/** What the runner told us beside the NIN and the selfie, checked and ready to store. */
interface SubmissionDetails {
  identity?: IdentityDetailsDto;
  idDocument?: { type: IdDocumentDto['type']; mediaId: string | null };
  guarantor?: GuarantorDto;
}

export interface VerificationOverview {
  status: string;
  displayStatus: DisplayStatus;
  /** True only while a valid (not expired, not revoked) verification exists. */
  verified: boolean;
  expiresAt: Date | null;
  phoneVerified: boolean;
  latestAttempt: AttemptView | null;
  /** Attempts left before the cooldown applies. */
  attemptsRemaining: number;
  /** When the next attempt is allowed, if the runner is waiting. */
  nextAttemptAt: Date | null;
  feeRequired: boolean;
  canStart: boolean;
}

interface Allowance {
  limit: number;
  used: number;
  remaining: number;
  nextAttemptAt: Date | null;
}

/**
 * Runner identity verification (Backend PRD 10.2 to 10.4): NIN plus selfie plus a verified
 * phone. The NIN is held in memory for the provider call only: it is never stored, logged or
 * returned. What is kept: provider reference, result, failure reason, masked attributes and a
 * keyed hash of the identity (one verified account per identity).
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly appConfig: ConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly media: MediaService,
    private readonly status: VerificationStatusService,
    private readonly pricing: PricingService,
    @Inject(KYC_PROVIDER) private readonly kyc: IKycProvider,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
  ) {}

  /**
   * The fee in kobo. The price version of the VERIFICATION_FEE product is the source of truth
   * (Backend PRD 22.1); the `VERIFICATION_FEE` config value is only the answer where no product
   * price has been set up.
   */
  async verificationFee(): Promise<number> {
    const price = await this.pricing.getCurrentPriceByCode('VERIFICATION_FEE');
    return price ? Number(price.amountKobo) : this.config.get('VERIFICATION_FEE');
  }

  async overview(userId: string): Promise<VerificationOverview> {
    const [latest, verified, user, fee] = await Promise.all([
      this.status.latest(userId),
      this.status.isVerified(userId),
      this.prisma.client.user.findUnique({ where: { id: userId }, select: { phoneVerifiedAt: true } }),
      this.verificationFee(),
    ]);
    const allowance = fee > 0 ? await this.paidAllowance(this.prisma, userId) : await this.allowance(this.prisma, userId);
    const pending = latest?.status === 'PENDING' || latest?.status === 'REVIEW_REQUIRED';
    const phoneVerified = Boolean(user?.phoneVerifiedAt);

    // A VERIFIED attempt past its expiry date is EXPIRED, even before the expiry job runs.
    const effective = latest?.status === 'VERIFIED' && !verified ? 'EXPIRED' : (latest?.status ?? 'NOT_STARTED');
    const verifiedAttempt = verified ? latest : null;

    return {
      status: effective,
      displayStatus: displayStatus(effective),
      verified,
      expiresAt: verifiedAttempt?.expiresAt ?? null,
      phoneVerified,
      latestAttempt: latest ? toAttemptView(latest) : null,
      attemptsRemaining: allowance.remaining,
      nextAttemptAt: allowance.nextAttemptAt,
      // A fee is asked for only until the runner has paid for attempts that are not used up.
      feeRequired: fee > 0 && allowance.remaining === 0,
      canStart: phoneVerified && !verified && !pending && allowance.remaining > 0,
    };
  }

  async getAttempt(userId: string, attemptId: string): Promise<AttemptView> {
    const attempt = await this.prisma.client.verificationAttempt.findFirst({ where: { id: attemptId, userId } });
    if (!attempt) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return toAttemptView(attempt);
  }

  /**
   * Run one verification attempt. Answers with the finished attempt: the provider call is
   * synchronous. A provider failure is an answer too (status FAILED), not an error response.
   */
  async startAttempt(
    userId: string,
    input: { nin: string; selfieMediaId: string; identity?: IdentityDetailsDto; idDocument?: IdDocumentDto; guarantor?: GuarantorDto },
    ctx: RequestContext = {},
  ): Promise<AttemptView> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { phoneVerifiedAt: true, phoneE164: true },
    });
    if (!user?.phoneVerifiedAt) {
      throw DomainException.of(FORBIDDEN, {
        message: 'Verify your phone number before identity verification.',
        details: { reason: 'PHONE_NOT_VERIFIED' },
      });
    }
    const selfie = await this.media.requireReadyOwned(userId, input.selfieMediaId, 'VERIFICATION_INPUT');
    const details = await this.checkDetails(userId, user.phoneE164, selfie.id, input);
    const attemptId = await this.open(userId, selfie.id, details);

    const result = await this.callProvider(selfie.storageKey, input.nin);
    return this.complete(attemptId, userId, result, input.nin, ctx);
  }

  /**
   * Attempts left on the paid allowance (Backend PRD 10.2, 22.3). Each paid fee grants
   * `VERIFICATION_ATTEMPTS_PER_FEE` attempts through a VERIFICATION_ATTEMPT_ALLOWANCE entitlement;
   * an attempt that counts against the allowance (a provider fault does not) uses one up. Only
   * used when a fee is charged: at a fee of zero the sliding retry window applies instead.
   */
  async paidAllowance(client: Prisma.TransactionClient | PrismaService, userId: string): Promise<Allowance> {
    const rows = await client.$queryRaw<Array<{ granted: number; used: number }>>`
      SELECT COALESCE(SUM(e.quantity), 0)::int AS granted,
             (
               SELECT count(*)::int FROM verification_attempts a
               WHERE a.user_id = ${userId}::uuid AND a.deleted_at IS NULL AND a.counts_against_allowance
                 AND a.started_at >= (
                   SELECT MIN(g.valid_from) FROM entitlements g
                   WHERE g.user_id = ${userId}::uuid AND g.type = 'VERIFICATION_ATTEMPT_ALLOWANCE'::"EntitlementType" AND g.revoked_at IS NULL
                 )
             ) AS used
      FROM entitlements e
      WHERE e.user_id = ${userId}::uuid AND e.type = 'VERIFICATION_ATTEMPT_ALLOWANCE'::"EntitlementType" AND e.revoked_at IS NULL
        AND (e.valid_until IS NULL OR e.valid_until > now())
    `;
    const granted = rows[0]?.granted ?? 0;
    const used = granted === 0 ? 0 : Math.min(granted, rows[0]?.used ?? 0);
    return { limit: granted, used, remaining: Math.max(0, granted - used), nextAttemptAt: null };
  }

  /** Attempts left in the current window (Backend PRD 10.2 retries). */
  async allowance(client: Prisma.TransactionClient | PrismaService, userId: string): Promise<Allowance> {
    const [limit, cooldownHours] = await Promise.all([
      this.config.get('VERIFICATION_ATTEMPTS_PER_FEE'),
      this.config.get('VERIFICATION_RETRY_COOLDOWN_HOURS'),
    ]);
    const rows = await client.$queryRaw<Array<{ free_at: Date }>>`
      SELECT completed_at + make_interval(hours => ${cooldownHours}::int) AS free_at
      FROM verification_attempts
      WHERE user_id = ${userId}::uuid
        AND status = 'FAILED'::"VerificationStatus"
        AND counts_against_allowance
        AND deleted_at IS NULL
        AND completed_at > now() - make_interval(hours => ${cooldownHours}::int)
      ORDER BY completed_at DESC
      LIMIT 50
    `;
    const used = rows.length;
    return {
      limit,
      used,
      remaining: Math.max(0, limit - used),
      // The window slides: the attempt slot returns when the `limit`-th most recent failure ages out.
      nextAttemptAt: used >= limit ? rows[limit - 1].free_at : null,
    };
  }

  /**
   * What an admin sees when a manual review is needed: the details, the ID document reference and
   * the guarantor (Backend PRD 10.2, demo runner verification). Personal data: only admin routes
   * with a verification permission may return it.
   */
  async getSubmission(attemptId: string): Promise<VerificationSubmissionDto | null> {
    const row = await this.prisma.client.verificationSubmission.findUnique({ where: { attemptId } });
    if (!row) {
      return null;
    }
    return {
      attemptId: row.attemptId,
      firstName: row.firstName,
      lastName: row.lastName,
      dateOfBirth: row.dateOfBirth ? row.dateOfBirth.toISOString().slice(0, 10) : null,
      addressLine: row.addressLine,
      lga: row.lga,
      idDocumentType: row.idDocumentType,
      idDocumentMediaId: row.idDocumentMediaId,
      guarantorName: row.guarantorName,
      guarantorRelationship: row.guarantorRelation,
      guarantorPhone: row.guarantorPhone,
      submittedAt: row.createdAt,
    };
  }

  /** Validate the optional details. A date of birth under 18 or a guarantor who is the runner is refused. */
  private async checkDetails(
    userId: string,
    ownPhone: string | null,
    selfieMediaId: string,
    input: { identity?: IdentityDetailsDto; idDocument?: IdDocumentDto; guarantor?: GuarantorDto },
  ): Promise<SubmissionDetails> {
    const details: SubmissionDetails = {};

    if (input.identity) {
      const born = new Date(`${input.identity.dateOfBirth}T00:00:00.000Z`);
      const now = new Date();
      const cutoff = new Date(Date.UTC(now.getUTCFullYear() - MINIMUM_AGE_YEARS, now.getUTCMonth(), now.getUTCDate()));
      if (Number.isNaN(born.getTime()) || born.getTime() > cutoff.getTime()) {
        throw DomainException.of(VALIDATION_ERROR, {
          message: `You must be at least ${MINIMUM_AGE_YEARS} years old to run errands.`,
          details: { field: 'identity.dateOfBirth' },
        });
      }
      details.identity = input.identity;
    }

    if (input.idDocument) {
      let mediaId: string | null = null;
      if (input.idDocument.mediaId) {
        if (input.idDocument.mediaId === selfieMediaId) {
          throw DomainException.of(VALIDATION_ERROR, {
            message: 'The ID document photo must be a different upload from the selfie.',
            details: { field: 'idDocument.mediaId' },
          });
        }
        const media = await this.media.requireReadyOwned(userId, input.idDocument.mediaId, 'VERIFICATION_INPUT');
        mediaId = media.id;
      }
      details.idDocument = { type: input.idDocument.type, mediaId };
    }

    if (input.guarantor) {
      if (ownPhone && input.guarantor.phone === ownPhone) {
        throw DomainException.of(VALIDATION_ERROR, {
          message: 'The guarantor needs a phone number of their own.',
          details: { field: 'guarantor.phone' },
        });
      }
      details.guarantor = input.guarantor;
    }
    return details;
  }

  /** Create the PENDING row. One attempt in flight per user, enforced by a lock and by the database. */
  private async open(userId: string, selfieMediaId: string, details: SubmissionDetails = {}): Promise<string> {
    const fee = await this.verificationFee();
    const provider = this.appConfig.get<string>('providers.kyc') === 'real' ? 'dojah' : 'fake';

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verification:${userId}`}))`;

      const state = await tx.$queryRaw<Array<{ verified: boolean; pending: boolean; attempts: number }>>`
        SELECT
          EXISTS (SELECT 1 FROM verification_attempts WHERE user_id = ${userId}::uuid AND status = 'VERIFIED'
                  AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS verified,
          EXISTS (SELECT 1 FROM verification_attempts WHERE user_id = ${userId}::uuid
                  AND status IN ('PENDING', 'REVIEW_REQUIRED') AND deleted_at IS NULL) AS pending,
          (SELECT count(*)::int FROM verification_attempts WHERE user_id = ${userId}::uuid) AS attempts
      `;
      if (state[0].verified) {
        throw DomainException.of(RESOURCE_CONFLICT, { message: 'You are already verified.' });
      }
      if (state[0].pending) {
        throw DomainException.of(VERIFICATION_PENDING);
      }
      if (fee > 0) {
        // With a fee, attempts come from a paid allowance (an order that was settled grants it once).
        const paid = await this.paidAllowance(tx, userId);
        if (paid.remaining === 0) {
          throw DomainException.of(VERIFICATION_FEE_REQUIRED);
        }
      }
      const allowance = fee > 0 ? { remaining: 1, nextAttemptAt: null } : await this.allowance(tx, userId);
      if (allowance.remaining === 0) {
        throw DomainException.of(RATE_LIMITED, {
          message: 'Too many failed verification attempts. Try again later.',
          details: { reason: 'VERIFICATION_COOLDOWN', retryAt: allowance.nextAttemptAt },
        });
      }

      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO verification_attempts (user_id, provider, status, attempt_number, selfie_media_id, started_at, updated_at)
        VALUES (${userId}::uuid, ${provider}, 'PENDING'::"VerificationStatus", ${state[0].attempts + 1},
                ${selfieMediaId}::uuid, now(), now())
        RETURNING id
      `;
      const attemptId = rows[0].id;
      if (details.identity || details.idDocument || details.guarantor) {
        await tx.verificationSubmission.create({
          data: {
            attemptId,
            userId,
            firstName: details.identity?.firstName.trim() ?? null,
            lastName: details.identity?.lastName.trim() ?? null,
            dateOfBirth: details.identity ? new Date(`${details.identity.dateOfBirth}T00:00:00.000Z`) : null,
            addressLine: details.identity?.addressLine.trim() ?? null,
            lga: details.identity?.lga.trim() ?? null,
            idDocumentType: details.idDocument?.type ?? null,
            idDocumentMediaId: details.idDocument?.mediaId ?? null,
            guarantorName: details.guarantor?.fullName.trim() ?? null,
            guarantorRelation: details.guarantor?.relationship ?? null,
            guarantorPhone: details.guarantor?.phone ?? null,
          },
        });
      }
      return attemptId;
    });
  }

  /** Call the provider within the configured timeout. Never throws: any fault becomes PROVIDER_ERROR. */
  private async callProvider(selfieKey: string, nin: string): Promise<KycVerifyResult> {
    const [threshold, timeoutSeconds] = await Promise.all([
      this.config.get('KYC_SELFIE_MATCH_THRESHOLD'),
      this.config.get('KYC_REQUEST_TIMEOUT_SECONDS'),
    ]);
    const timeoutMs = timeoutSeconds * 1000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const selfie = await this.storage.getObject(selfieKey);
      const timeout = new Promise<KycVerifyResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ outcome: 'FAILED', failureReason: 'PROVIDER_TIMEOUT', countsAgainstAllowance: false }),
          timeoutMs,
        );
      });
      return await Promise.race([
        this.kyc.verifyNinWithSelfie({ nin, selfieImageBase64: selfie.toString('base64'), threshold, timeoutMs }),
        timeout,
      ]);
    } catch (error) {
      // The message is not logged: it could carry request data.
      this.logger.error(`KYC call failed: ${error instanceof Error ? error.name : 'unknown error'}`);
      return { outcome: 'FAILED', failureReason: 'PROVIDER_ERROR', countsAgainstAllowance: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Record the provider's answer. Guarded by `status = 'PENDING'`: a late answer changes nothing. */
  private async complete(
    attemptId: string,
    userId: string,
    result: KycVerifyResult,
    nin: string,
    ctx: RequestContext,
  ): Promise<AttemptView> {
    let outcome: KycVerifyResult = result;
    let identityHmac: string | null = null;

    if (result.outcome === 'VERIFIED') {
      // The NIN is hashed here and dropped; the hash alone identifies the person.
      identityHmac = hmacSign(`nin:${nin}`, this.appConfig.getOrThrow<string>('security.hmacSecret'));
      const taken = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM verification_attempts
        WHERE identity_ref_hmac = ${identityHmac} AND status = 'VERIFIED'::"VerificationStatus"
          AND deleted_at IS NULL AND user_id <> ${userId}::uuid
        LIMIT 1
      `;
      if (taken.length > 0) {
        outcome = { outcome: 'FAILED', failureReason: 'DUPLICATE_IDENTITY', countsAgainstAllowance: true };
        identityHmac = null;
      }
    }

    try {
      await this.write(attemptId, userId, outcome, identityHmac, ctx);
    } catch (error) {
      if (!isIdentityConflict(error)) {
        throw error;
      }
      // Two accounts verified the same identity at the same moment; the database let one win.
      await this.write(
        attemptId,
        userId,
        { outcome: 'FAILED', failureReason: 'DUPLICATE_IDENTITY', countsAgainstAllowance: true },
        null,
        ctx,
      );
    }

    const final = await this.prisma.client.verificationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    return toAttemptView(final);
  }

  private async write(
    attemptId: string,
    userId: string,
    outcome: KycVerifyResult,
    identityHmac: string | null,
    ctx: RequestContext,
  ): Promise<void> {
    const validityDays = await this.config.get('VERIFICATION_VALIDITY_DAYS');
    const verified = outcome.outcome === 'VERIFIED';
    const reason: VerificationFailureReason | null = verified ? null : (outcome.failureReason as VerificationFailureReason);
    const masked = outcome.maskedAttributes ? JSON.stringify(outcome.maskedAttributes) : null;
    const status = verified ? 'VERIFIED' : 'FAILED';

    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ attempt_number: number }>>`
        UPDATE verification_attempts
        SET status = ${status}::"VerificationStatus",
            failure_reason = ${reason}::"VerificationFailureReason",
            provider_status = ${verified ? 'match' : (reason as string)},
            provider_request_id = ${outcome.providerRequestId ?? null},
            identity_ref_hmac = ${identityHmac},
            masked_attributes = ${masked}::jsonb,
            confidence = ${outcome.confidence ?? null}::numeric,
            counts_against_allowance = ${outcome.countsAgainstAllowance},
            completed_at = now(),
            expires_at = CASE WHEN ${verified} AND ${validityDays}::int > 0
                              THEN now() + make_interval(days => ${validityDays}::int) ELSE NULL END,
            updated_at = now()
        WHERE id = ${attemptId}::uuid AND status = 'PENDING'::"VerificationStatus"
        RETURNING attempt_number
      `;
      if (rows.length === 0) {
        return; // already decided (for example by the stale-attempt sweeper): keep that decision
      }

      await this.outbox.add(tx, {
        eventType: verified ? 'verification.completed' : 'verification.failed',
        aggregateType: 'verification_attempt',
        aggregateId: attemptId,
        payload: { userId, attemptId, status, failureReason: reason },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: verified ? 'verification.verified' : 'verification.failed',
        entityType: 'verification_attempt',
        entityId: attemptId,
        reasonCode: reason ?? undefined,
        requestId: ctx.requestId,
        ip: ctx.ip,
        metadata: { attemptNumber: rows[0].attempt_number, countsAgainstAllowance: outcome.countsAgainstAllowance },
      });
    });

    if (reason === 'PROVIDER_ERROR') {
      this.logger.error(`ALERT: verification attempt ${attemptId} ended in PROVIDER_ERROR`);
    }
  }
}

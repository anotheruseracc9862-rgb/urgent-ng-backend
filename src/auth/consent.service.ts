import { Injectable } from '@nestjs/common';
import { ConsentType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { AuthAuditService, type RequestContext } from './auth-audit.service.js';
import { PolicyService, type PolicyVersionView } from './policy.service.js';

export interface ConsentView {
  id: string;
  type: ConsentType;
  version: string;
  acceptedAt: Date;
  withdrawnAt: Date | null;
}

/** Optional consents the user may withdraw at any time. Required policies cannot be withdrawn. */
const WITHDRAWABLE: ConsentType[] = [ConsentType.MARKETING_COMMUNICATIONS, ConsentType.LOCATION_SHARING];

/**
 * Versioned consent (Backend PRD 9.6). The backend can always say which version a
 * user accepted and when. Marketing consent is separate; withdrawing it never blocks service.
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PolicyService,
    private readonly audit: AuthAuditService,
  ) {}

  /** Accept a published policy version. Accepting the same version twice returns the existing record. */
  async accept(
    userId: string,
    type: ConsentType,
    version: string,
    ctx: RequestContext = {},
  ): Promise<ConsentView> {
    const published = await this.policies.findPublished(type, version);
    if (!published) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'That policy version does not exist.' });
    }

    const existing = await this.prisma.consentRecord.findFirst({
      where: { userId, consentType: type, documentVersion: version, withdrawnAt: null },
    });
    if (existing) {
      return this.view(existing);
    }

    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; accepted_at: Date }>
    >`
      INSERT INTO consent_records (user_id, consent_type, document_version, accepted_at, ip_address, user_agent)
      VALUES (${userId}::uuid, ${type}::"ConsentType", ${version}, now(), ${ctx.ip ?? null}::inet, ${ctx.userAgent ?? null})
      RETURNING id, accepted_at
    `;
    await this.audit.record({
      action: 'consent.accepted',
      actorId: userId,
      metadata: { type, version },
      ctx,
    });
    return { id: rows[0].id, type, version, acceptedAt: rows[0].accepted_at, withdrawnAt: null };
  }

  /** Withdraw an optional consent. */
  async withdraw(userId: string, consentId: string, ctx: RequestContext = {}): Promise<void> {
    const record = await this.prisma.consentRecord.findFirst({ where: { id: consentId, userId } });
    if (!record) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (!WITHDRAWABLE.includes(record.consentType)) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'This policy is required to use the service and cannot be withdrawn.',
      });
    }
    await this.prisma.$executeRaw`
      UPDATE consent_records SET withdrawn_at = now()
      WHERE id = ${consentId}::uuid AND user_id = ${userId}::uuid AND withdrawn_at IS NULL
    `;
    await this.audit.record({
      action: 'consent.withdrawn',
      actorId: userId,
      metadata: { type: record.consentType, version: record.documentVersion },
      ctx,
    });
  }

  /** The full history, newest first, plus the policies still waiting for acceptance. */
  async history(userId: string): Promise<{ consents: ConsentView[]; outstanding: PolicyVersionView[] }> {
    const [records, outstanding] = await Promise.all([
      this.prisma.consentRecord.findMany({ where: { userId }, orderBy: { acceptedAt: 'desc' } }),
      this.policies.outstandingFor(userId),
    ]);
    return { consents: records.map((record) => this.view(record)), outstanding };
  }

  private view(record: {
    id: string;
    consentType: ConsentType;
    documentVersion: string;
    acceptedAt: Date;
    withdrawnAt: Date | null;
  }): ConsentView {
    return {
      id: record.id,
      type: record.consentType,
      version: record.documentVersion,
      acceptedAt: record.acceptedAt,
      withdrawnAt: record.withdrawnAt,
    };
  }
}

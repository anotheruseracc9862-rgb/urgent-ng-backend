import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { MediaService } from '../media/media.service.js';

const BATCH = 100;
/** Extra seconds after the provider timeout before a PENDING attempt is treated as abandoned. */
const STALE_GRACE_SECONDS = 120;

/**
 * Housekeeping for verification, run by the scheduler (Backend PRD 10.2, 10.4). All time
 * comparisons use the database clock.
 *
 * Expiry only ends the verification: it blocks new offers (the eligibility service reads the
 * status) and never cancels an existing assignment.
 */
@Injectable()
export class VerificationExpiryService {
  private readonly logger = new Logger(VerificationExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly media: MediaService,
  ) {}

  /** VERIFIED attempts past `expires_at` become EXPIRED. Returns how many. */
  async expireDue(limit = BATCH): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM verification_attempts
      WHERE status = 'VERIFIED'::"VerificationStatus" AND deleted_at IS NULL
        AND expires_at IS NOT NULL AND expires_at <= now()
      ORDER BY expires_at
      LIMIT ${limit}
    `;
    let expired = 0;
    for (const { id } of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
          UPDATE verification_attempts SET status = 'EXPIRED'::"VerificationStatus", updated_at = now()
          WHERE id = ${id}::uuid AND status = 'VERIFIED'::"VerificationStatus" AND expires_at <= now()
          RETURNING user_id
        `;
        if (rows.length === 0) return false;
        await this.outbox.add(tx, {
          eventType: 'verification.expired',
          aggregateType: 'verification_attempt',
          aggregateId: id,
          payload: { userId: rows[0].user_id, attemptId: id, status: 'EXPIRED' },
        });
        await this.audit.recordInTransaction(tx, {
          actorType: AuditActorType.SYSTEM,
          action: 'verification.expired',
          entityType: 'verification_attempt',
          entityId: id,
          metadata: { userId: rows[0].user_id },
        });
        return true;
      });
      if (done) expired += 1;
    }
    return expired;
  }

  /**
   * A PENDING attempt whose request never finished (the process died mid-call) would block the
   * runner for ever. After the provider timeout plus a grace period it fails as a provider
   * fault, which does not count against the allowance.
   */
  async failStalePending(limit = BATCH): Promise<number> {
    const timeoutSeconds = await this.config.get('KYC_REQUEST_TIMEOUT_SECONDS');
    const seconds = timeoutSeconds + STALE_GRACE_SECONDS;
    const stale = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM verification_attempts
      WHERE status = 'PENDING'::"VerificationStatus" AND deleted_at IS NULL
        AND started_at < now() - make_interval(secs => ${seconds}::int)
      ORDER BY started_at
      LIMIT ${limit}
    `;
    let failed = 0;
    for (const { id } of stale) {
      const done = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
          UPDATE verification_attempts
          SET status = 'FAILED'::"VerificationStatus", failure_reason = 'PROVIDER_ERROR'::"VerificationFailureReason",
              provider_status = 'abandoned', counts_against_allowance = false, completed_at = now(), updated_at = now()
          WHERE id = ${id}::uuid AND status = 'PENDING'::"VerificationStatus"
          RETURNING user_id
        `;
        if (rows.length === 0) return false;
        await this.outbox.add(tx, {
          eventType: 'verification.failed',
          aggregateType: 'verification_attempt',
          aggregateId: id,
          payload: { userId: rows[0].user_id, attemptId: id, status: 'FAILED', failureReason: 'PROVIDER_ERROR' },
        });
        return true;
      });
      if (done) failed += 1;
    }
    if (failed > 0) {
      this.logger.warn(`ALERT: ${failed} verification attempt(s) were abandoned mid-call and failed as PROVIDER_ERROR`);
    }
    return failed;
  }

  /** Staged selfies are deleted STAGED_SELFIE_RETENTION_DAYS after the decision (Backend PRD 10.4). */
  async deleteStagedSelfies(limit = BATCH): Promise<number> {
    const days = await this.config.get('STAGED_SELFIE_RETENTION_DAYS');
    const due = await this.prisma.$queryRaw<Array<{ id: string; media_id: string }>>`
      SELECT id, selfie_media_id AS media_id FROM verification_attempts
      WHERE selfie_media_id IS NOT NULL AND deleted_at IS NULL
        AND status NOT IN ('PENDING'::"VerificationStatus", 'REVIEW_REQUIRED'::"VerificationStatus")
        AND completed_at IS NOT NULL
        AND completed_at < now() - make_interval(days => ${days}::int)
      ORDER BY completed_at
      LIMIT ${limit}
    `;
    let deleted = 0;
    for (const row of due) {
      const media = await this.prisma.client.media.findUnique({ where: { id: row.media_id } });
      if (media) {
        await this.media.softDelete(media);
      }
      await this.prisma.$executeRaw`UPDATE verification_attempts SET selfie_media_id = NULL, updated_at = now() WHERE id = ${row.id}::uuid`;
      deleted += 1;
    }
    return deleted;
  }
}

import { Injectable } from '@nestjs/common';
import { AuditActorType, type Prisma, type VerificationFailureReason, type VerificationStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { DUPLICATE_IDENTITY, RESOURCE_CONFLICT, RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import { isIdentityConflict } from './unique-violation.js';
import { canTransition } from './verification.state.js';
import { toAttemptView, type AttemptView } from './verification-status.service.js';

export interface AdminActor {
  adminId: string;
  ip?: string;
  requestId?: string;
}

interface LockedAttempt {
  id: string;
  user_id: string;
  status: VerificationStatus;
  failure_reason: VerificationFailureReason | null;
}

/**
 * Actions an administrator can take on verification (Backend PRD 10.2). These are service
 * methods; the admin controllers that call them arrive with the admin console (P11). Every
 * action needs an actor and a reason, and writes an audit row and an outbox event in the same
 * transaction as the change.
 */
@Injectable()
export class VerificationAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Approve a REVIEW_REQUIRED attempt, or override a FAILED one. A duplicate identity is never approved. */
  async approve(attemptId: string, actor: AdminActor, reason: string): Promise<AttemptView> {
    const validityDays = await this.config.get('VERIFICATION_VALIDITY_DAYS');

    try {
      await this.prisma.$transaction(async (tx) => {
        const attempt = await this.lock(tx, attemptId);
        if (attempt.failure_reason === 'DUPLICATE_IDENTITY') {
          throw DomainException.of(DUPLICATE_IDENTITY);
        }
        this.assertTransition(attempt.status, 'VERIFIED');
        await tx.$executeRaw`
          UPDATE verification_attempts
          SET status = 'VERIFIED'::"VerificationStatus", failure_reason = NULL, provider_status = 'admin_approved',
              completed_at = now(), counts_against_allowance = true,
              expires_at = CASE WHEN ${validityDays}::int > 0 THEN now() + make_interval(days => ${validityDays}::int) ELSE NULL END,
              updated_at = now()
          WHERE id = ${attemptId}::uuid
        `;
        await this.record(tx, actor, 'verification.approved', attempt, reason, 'verification.completed', {
          userId: attempt.user_id,
          attemptId,
          status: 'VERIFIED',
          failureReason: null,
        });
      });
    } catch (error) {
      if (isIdentityConflict(error)) {
        throw DomainException.of(DUPLICATE_IDENTITY);
      }
      throw error;
    }
    return this.view(attemptId);
  }

  /** Reject a PENDING or REVIEW_REQUIRED attempt. */
  async reject(
    attemptId: string,
    actor: AdminActor,
    input: { reason: string; failureReason?: VerificationFailureReason; countsAgainstAllowance?: boolean },
  ): Promise<AttemptView> {
    const failureReason = input.failureReason ?? 'OTHER';
    await this.prisma.$transaction(async (tx) => {
      const attempt = await this.lock(tx, attemptId);
      this.assertTransition(attempt.status, 'FAILED');
      await tx.$executeRaw`
        UPDATE verification_attempts
        SET status = 'FAILED'::"VerificationStatus", failure_reason = ${failureReason}::"VerificationFailureReason",
            provider_status = 'admin_rejected', completed_at = now(),
            counts_against_allowance = ${input.countsAgainstAllowance ?? true}, updated_at = now()
        WHERE id = ${attemptId}::uuid
      `;
      await this.record(tx, actor, 'verification.rejected', attempt, input.reason, 'verification.failed', {
        userId: attempt.user_id,
        attemptId,
        status: 'FAILED',
        failureReason,
      });
    });
    return this.view(attemptId);
  }

  /**
   * Give the runner a fresh set of attempts: earlier failures stop counting against the
   * allowance (they stay on record). Returns how many were reset.
   */
  async grantExtraAttempts(userId: string, actor: AdminActor, reason: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verification:${userId}`}))`;
      const reset = await tx.$executeRaw`
        UPDATE verification_attempts SET counts_against_allowance = false, updated_at = now()
        WHERE user_id = ${userId}::uuid AND status = 'FAILED'::"VerificationStatus"
          AND counts_against_allowance AND deleted_at IS NULL
      `;
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: actor.adminId,
        action: 'verification.attempts_granted',
        entityType: 'user',
        entityId: userId,
        requestId: actor.requestId,
        ip: actor.ip,
        metadata: { reason, reset },
      });
      await this.outbox.add(tx, {
        eventType: 'verification.attempts_granted',
        aggregateType: 'user',
        aggregateId: userId,
        payload: { userId, reset },
      });
      return reset;
    });
  }

  /** Revoke a current verification. Existing assignments are not touched here (Backend PRD 10.2). */
  async revoke(userId: string, actor: AdminActor, reason: string): Promise<AttemptView> {
    const attemptId = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verification:${userId}`}))`;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM verification_attempts
        WHERE user_id = ${userId}::uuid AND status = 'VERIFIED'::"VerificationStatus" AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `;
      if (rows.length === 0) {
        throw DomainException.of(RESOURCE_CONFLICT, { message: 'This user has no verification to revoke.' });
      }
      const attempt = await this.lock(tx, rows[0].id);
      this.assertTransition(attempt.status, 'REVOKED');
      await tx.$executeRaw`
        UPDATE verification_attempts SET status = 'REVOKED'::"VerificationStatus", updated_at = now()
        WHERE id = ${attempt.id}::uuid
      `;
      await this.record(tx, actor, 'verification.revoked', attempt, reason, 'verification.revoked', {
        userId,
        attemptId: attempt.id,
        status: 'REVOKED',
        failureReason: null,
      });
      return attempt.id;
    });
    return this.view(attemptId);
  }

  private async lock(tx: Prisma.TransactionClient, attemptId: string): Promise<LockedAttempt> {
    const rows = await tx.$queryRaw<LockedAttempt[]>`
      SELECT id, user_id, status, failure_reason FROM verification_attempts
      WHERE id = ${attemptId}::uuid AND deleted_at IS NULL FOR UPDATE
    `;
    if (rows.length === 0) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return rows[0];
  }

  private assertTransition(from: VerificationStatus, to: VerificationStatus): void {
    if (!canTransition(from, to)) {
      throw DomainException.of(RESOURCE_CONFLICT, {
        message: `A ${from} verification cannot become ${to}.`,
        details: { from, to },
      });
    }
  }

  private async record(
    tx: Prisma.TransactionClient,
    actor: AdminActor,
    action: string,
    attempt: LockedAttempt,
    reason: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.recordInTransaction(tx, {
      actorType: AuditActorType.ADMIN,
      actorId: actor.adminId,
      action,
      entityType: 'verification_attempt',
      entityId: attempt.id,
      requestId: actor.requestId,
      ip: actor.ip,
      metadata: { reason, userId: attempt.user_id, from: attempt.status },
    });
    await this.outbox.add(tx, {
      eventType,
      aggregateType: 'verification_attempt',
      aggregateId: attempt.id,
      payload,
    });
  }

  private async view(attemptId: string): Promise<AttemptView> {
    return toAttemptView(await this.prisma.client.verificationAttempt.findUniqueOrThrow({ where: { id: attemptId } }));
  }
}

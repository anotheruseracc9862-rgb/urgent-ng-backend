import { Injectable } from '@nestjs/common';
import type { VerificationAttempt, VerificationFailureReason, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { displayStatus, type DisplayStatus } from './verification.state.js';

export interface AttemptView {
  id: string;
  status: VerificationStatus;
  displayStatus: DisplayStatus;
  failureReason: VerificationFailureReason | null;
  attemptNumber: number;
  startedAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
}

/** The runner-facing view of an attempt. Never includes the identity hash, masked attributes or the selfie. */
export const toAttemptView = (attempt: VerificationAttempt): AttemptView => ({
  id: attempt.id,
  status: attempt.status,
  displayStatus: displayStatus(attempt.status),
  failureReason: attempt.failureReason,
  attemptNumber: attempt.attemptNumber,
  startedAt: attempt.startedAt,
  completedAt: attempt.completedAt,
  expiresAt: attempt.expiresAt,
});

/**
 * Where a user stands right now. The current state is the state of the latest attempt, except
 * that a VERIFIED attempt whose `expires_at` has passed no longer counts, even before the expiry
 * job has run (compared on the database clock).
 */
@Injectable()
export class VerificationStatusService {
  constructor(private readonly prisma: PrismaService) {}

  latest(userId: string): Promise<VerificationAttempt | null> {
    return this.prisma.client.verificationAttempt.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async isVerified(userId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM verification_attempts
        WHERE user_id = ${userId}::uuid
          AND status = 'VERIFIED'::"VerificationStatus"
          AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
      ) AS ok
    `;
    return rows[0].ok;
  }

  /** True while the latest attempt waits for the provider or for an admin. */
  async isPending(userId: string): Promise<boolean> {
    const latest = await this.latest(userId);
    return latest?.status === 'PENDING' || latest?.status === 'REVIEW_REQUIRED';
  }
}

import type { VerificationStatus } from '@prisma/client';

/**
 * Verification state machine (Backend PRD 10.2). `NOT_STARTED` is "no attempt row yet", so it
 * has no stored form; a new attempt starts at PENDING.
 *
 *   PENDING ─▶ VERIFIED | FAILED | REVIEW_REQUIRED
 *   REVIEW_REQUIRED ─▶ VERIFIED | FAILED          (an admin decides)
 *   FAILED ─▶ VERIFIED                             (an admin overrides a user-data failure)
 *   VERIFIED ─▶ EXPIRED | REVOKED
 *   EXPIRED, REVOKED: final (the runner starts a new attempt)
 */
export const VERIFICATION_TRANSITIONS: Readonly<Record<VerificationStatus, readonly VerificationStatus[]>> = {
  NOT_STARTED: ['PENDING'],
  PENDING: ['VERIFIED', 'FAILED', 'REVIEW_REQUIRED'],
  REVIEW_REQUIRED: ['VERIFIED', 'FAILED'],
  FAILED: ['VERIFIED'],
  VERIFIED: ['EXPIRED', 'REVOKED'],
  EXPIRED: [],
  REVOKED: [],
};

export const canTransition = (from: VerificationStatus, to: VerificationStatus): boolean =>
  VERIFICATION_TRANSITIONS[from].includes(to);

/** What the runner sees: PENDING and REVIEW_REQUIRED are "Pending", FAILED and REVOKED are "Rejected". */
export type DisplayStatus = 'NOT_STARTED' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

export function displayStatus(status: VerificationStatus): DisplayStatus {
  switch (status) {
    case 'PENDING':
    case 'REVIEW_REQUIRED':
      return 'PENDING';
    case 'FAILED':
    case 'REVOKED':
      return 'REJECTED';
    default:
      return status;
  }
}

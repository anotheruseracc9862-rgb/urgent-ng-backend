/**
 * The reliability rules as data (Backend PRD 21.1). Pure: no database, no clock. The service turns
 * a severity class into points from configuration, so changing a weight is a config change.
 */

export const RELIABILITY_EVENT_TYPES = [
  'OFFER_SUBMITTED',
  'ASSIGNMENT_ACCEPTED',
  'ASSIGNMENT_DECLINED',
  'ASSIGNMENT_TIMEOUT',
  'ASSIGNMENT_CANCELLED',
  'EXECUTION_STARTED',
  'PICKUP_CONFIRMED',
  'DELIVERY_CONFIRMED',
  'ERRAND_COMPLETED',
  'ERRAND_AUTO_COMPLETED',
  'ERRAND_DISPUTED',
  'DISPUTE_RESOLVED',
  'NO_SHOW',
  'LATE_CANCELLATION',
  'NO_RESPONSE_AFTER_ACCEPT',
  'FALSE_NON_COMPLETION_CLAIM',
  'VALID_REPORT_UPHELD',
] as const;

export type ReliabilityEventType = (typeof RELIABILITY_EVENT_TYPES)[number];

/** NONE carries no points (positive and neutral facts). SEVERE skips the ladder (Backend PRD 21.1). */
export type ReliabilitySeverity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

/** The class of each event type. `ASSIGNMENT_CANCELLED` depends on the stage: see `cancellationSeverity`. */
export const SEVERITY_BY_TYPE: Record<Exclude<ReliabilityEventType, 'ASSIGNMENT_CANCELLED'>, ReliabilitySeverity> = {
  OFFER_SUBMITTED: 'NONE',
  ASSIGNMENT_ACCEPTED: 'NONE',
  ASSIGNMENT_DECLINED: 'LOW',
  ASSIGNMENT_TIMEOUT: 'LOW',
  EXECUTION_STARTED: 'NONE',
  PICKUP_CONFIRMED: 'NONE',
  DELIVERY_CONFIRMED: 'NONE',
  ERRAND_COMPLETED: 'NONE',
  ERRAND_AUTO_COMPLETED: 'NONE',
  ERRAND_DISPUTED: 'NONE',
  DISPUTE_RESOLVED: 'NONE',
  LATE_CANCELLATION: 'MEDIUM',
  NO_RESPONSE_AFTER_ACCEPT: 'MEDIUM',
  VALID_REPORT_UPHELD: 'MEDIUM',
  NO_SHOW: 'HIGH',
  FALSE_NON_COMPLETION_CLAIM: 'HIGH',
};

/** Cancelling at ACCEPTED is low, at IN_PROGRESS medium, after PICKED_UP high (Backend PRD 21.1). */
export function cancellationSeverity(stage: string | null | undefined): ReliabilitySeverity {
  switch (stage) {
    case 'ACCEPTED':
      return 'LOW';
    case 'IN_PROGRESS':
      return 'MEDIUM';
    case 'PICKED_UP':
    case 'DELIVERED':
      return 'HIGH';
    default:
      // RUNNER_SELECTED: the runner had not accepted yet, so nobody was relying on them.
      return 'NONE';
  }
}

/**
 * Is a requester's cancellation "late"? A cancel after the scheduled time minus the lead window
 * (Backend PRD 21.1 definitions). ASAP errands have no schedule, so only the stage matters there.
 */
export function isLateRequesterCancellation(input: {
  scheduledAt: Date | null;
  cancelledAt: Date;
  leadMinutes: number;
}): boolean {
  if (!input.scheduledAt) return false;
  return input.cancelledAt.getTime() >= input.scheduledAt.getTime() - input.leadMinutes * 60_000;
}

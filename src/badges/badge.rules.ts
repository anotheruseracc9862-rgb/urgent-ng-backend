/**
 * Badge rules as pure functions (Backend PRD 21.5). Badges are earned, derived from existing data
 * and display-only: they never gate the feed or offering and never affect ranking. Every
 * threshold is configuration.
 */

export type BadgeName = 'NEW' | 'TRUSTED' | 'FAST_RESPONDER' | 'PRO' | 'NEW_REQUESTER' | 'PROMPT_PAYER';

export const RUNNER_BADGES: readonly BadgeName[] = ['NEW', 'TRUSTED', 'FAST_RESPONDER', 'PRO'];
export const REQUESTER_BADGES: readonly BadgeName[] = ['NEW_REQUESTER', 'PROMPT_PAYER'];
export const ALL_BADGES: readonly BadgeName[] = [...RUNNER_BADGES, ...REQUESTER_BADGES];

export interface BadgeThresholds {
  /** NEW: fewer completed errands than this. */
  newBelowCompleted: number;
  trustedMinCompleted: number;
  trustedMinRatings: number;
  /** Earn at this average, keep until it falls below `ratingKeep` (hysteresis, so a badge does not flap). */
  ratingEarn: number;
  ratingKeep: number;
  trustedMaxCancellationPercent: number;
  fastResponderMaxMinutes: number;
  fastResponderMinSamples: number;
  newRequesterBelowCompleted: number;
  promptPayerMinCompleted: number;
  promptPayerMinRatings: number;
}

/** Everything the rules read about a user, computed from source rows by BadgeMetricsService. */
export interface BadgeMetrics {
  // Runner side
  isRunner: boolean;
  runnerCompleted: number;
  /** Completed errands whose agreed amount reached the anti-gaming minimum. */
  runnerQualifyingCompleted: number;
  /** Distinct requesters who rated the runner on qualifying errands. */
  distinctRaters: number;
  /** Mean of each requester's own average, so one requester cannot stuff the figure. */
  ratingAverage: number | null;
  /** Percent of the last N accepted assignments the runner cancelled, or null with no sample. */
  cancellationPercent: number | null;
  hasRecentHighSeverity: boolean;
  hasActiveRestriction: boolean;
  medianResponseMinutes: number | null;
  responseSamples: number;
  isPro: boolean;
  // Requester side
  hasPostedErrand: boolean;
  requesterCompleted: number;
  requesterQualifyingCompleted: number;
  paymentConductCount: number;
  paymentConductAverage: number | null;
  hasUpheldNonPaymentRecently: boolean;
}

/**
 * The badges the user should hold now. `held` makes the rating rules sticky (hysteresis);
 * `removed` are badges an active BADGE_REMOVAL action keeps off.
 */
export function evaluateBadges(
  m: BadgeMetrics,
  t: BadgeThresholds,
  held: ReadonlySet<BadgeName>,
  removed: ReadonlySet<BadgeName>,
): Set<BadgeName> {
  const out = new Set<BadgeName>();
  const ratingBar = (badge: BadgeName) => (held.has(badge) ? t.ratingKeep : t.ratingEarn);

  if (m.isRunner && m.runnerCompleted < t.newBelowCompleted) out.add('NEW');

  if (
    m.isRunner &&
    m.runnerQualifyingCompleted >= t.trustedMinCompleted &&
    m.distinctRaters >= t.trustedMinRatings &&
    m.ratingAverage !== null &&
    m.ratingAverage >= ratingBar('TRUSTED') &&
    m.cancellationPercent !== null &&
    m.cancellationPercent <= t.trustedMaxCancellationPercent &&
    !m.hasRecentHighSeverity &&
    !m.hasActiveRestriction
  ) {
    out.add('TRUSTED');
  }

  if (
    m.isRunner &&
    m.medianResponseMinutes !== null &&
    m.responseSamples >= t.fastResponderMinSamples &&
    m.medianResponseMinutes < t.fastResponderMaxMinutes
  ) {
    out.add('FAST_RESPONDER');
  }

  if (m.isRunner && m.isPro) out.add('PRO');

  if (m.hasPostedErrand && m.requesterCompleted < t.newRequesterBelowCompleted) out.add('NEW_REQUESTER');

  if (
    m.requesterQualifyingCompleted >= t.promptPayerMinCompleted &&
    m.paymentConductCount >= t.promptPayerMinRatings &&
    m.paymentConductAverage !== null &&
    m.paymentConductAverage >= ratingBar('PROMPT_PAYER') &&
    !m.hasUpheldNonPaymentRecently
  ) {
    out.add('PROMPT_PAYER');
  }

  for (const badge of removed) out.delete(badge);
  return out;
}

/** Median of response times in minutes. A conversation never answered counts as slower than any answer. */
export function medianMinutes(values: Array<number | null>): number | null {
  if (values.length === 0) return null;
  const sorted = values.map((v) => (v === null ? Number.POSITIVE_INFINITY : v)).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Number.isFinite(value) ? value : null;
}

/** The badge to show first beside a name: the strongest trust signal the user holds. */
export const BADGE_DISPLAY_ORDER: readonly BadgeName[] = ['TRUSTED', 'PROMPT_PAYER', 'FAST_RESPONDER', 'PRO', 'NEW', 'NEW_REQUESTER'];

export function sortForDisplay(badges: Iterable<string>): string[] {
  const set = new Set(badges);
  return BADGE_DISPLAY_ORDER.filter((b) => set.has(b));
}

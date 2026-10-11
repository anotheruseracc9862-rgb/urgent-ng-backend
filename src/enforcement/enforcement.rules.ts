/**
 * The enforcement ladder as data (Backend PRD 21.4). Pure: thresholds in, levels out.
 *
 *   >= warning       a warning
 *   >= restriction   a 7-day offering and posting restriction
 *   >= suspension    a 30-day suspension
 *   >= adminReview   an admin decides on permanent action (nothing is applied automatically)
 *
 * Positive events carry no points, so they never lower a level.
 */

export type LadderLevel = 'WARNING' | 'RESTRICTION' | 'SUSPENSION' | 'ADMIN_REVIEW';

export interface LadderThresholds {
  warning: number;
  restriction: number;
  suspension: number;
  adminReview: number;
}

export const LADDER_ORDER: readonly LadderLevel[] = ['WARNING', 'RESTRICTION', 'SUSPENSION', 'ADMIN_REVIEW'];

/** Every level the points have reached, lowest first. */
export function levelsReached(points: number, thresholds: LadderThresholds): LadderLevel[] {
  const at: Record<LadderLevel, number> = {
    WARNING: thresholds.warning,
    RESTRICTION: thresholds.restriction,
    SUSPENSION: thresholds.suspension,
    ADMIN_REVIEW: thresholds.adminReview,
  };
  return LADDER_ORDER.filter((level) => points >= at[level]);
}

/** The restriction types of a FEATURE_RESTRICTION at the ladder's restriction level. */
export const LADDER_RESTRICTION_TYPES = ['OFFERING', 'POSTING'] as const;

/** User-facing wording for an action the ladder applied. It names the points, never another user. */
export function ladderReason(level: 'WARNING' | 'RESTRICTION' | 'SUSPENSION', points: number, windowDays: number): string {
  const base = `Your account reached ${points} reliability points in the last ${windowDays} days.`;
  switch (level) {
    case 'WARNING':
      return `${base} This is a warning.`;
    case 'RESTRICTION':
      return `${base} Making offers and posting errands is paused for a while.`;
    case 'SUSPENSION':
      return `${base} Your account is suspended for a while.`;
  }
}

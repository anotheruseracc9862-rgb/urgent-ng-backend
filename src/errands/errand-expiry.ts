/**
 * When an errand stops accepting offers (Backend PRD 11.4). Pure; the caller passes the moment
 * of publishing (taken from the database clock) and the configured values.
 */

export interface ExpiryConfig {
  /** ASAP errands stay open this long. */
  expiryHours: number;
  /** A scheduled errand closes this long before its start time. */
  scheduledBufferMinutes: number;
  /** A scheduled errand is never open longer than this many days. */
  scheduledMaxOpenDays: number;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function computeExpiresAt(
  timeMode: 'ASAP' | 'SCHEDULED',
  scheduledAt: Date | null,
  publishedAt: Date,
  config: ExpiryConfig,
): Date {
  if (timeMode === 'ASAP') {
    return new Date(publishedAt.getTime() + config.expiryHours * HOUR_MS);
  }
  if (!scheduledAt) {
    throw new Error('A scheduled errand needs scheduledAt');
  }
  const beforeStart = scheduledAt.getTime() - config.scheduledBufferMinutes * MINUTE_MS;
  const longestOpen = publishedAt.getTime() + config.scheduledMaxOpenDays * DAY_MS;
  return new Date(Math.min(beforeStart, longestOpen));
}

export interface ScheduleBounds {
  minLeadHours: number;
  maxDaysAhead: number;
}

/** A scheduled time must be at least `minLeadHours` and at most `maxDaysAhead` days after `now`. */
export function isScheduleInRange(scheduledAt: Date, now: Date, bounds: ScheduleBounds): boolean {
  const lead = scheduledAt.getTime() - now.getTime();
  return lead >= bounds.minLeadHours * HOUR_MS && lead <= bounds.maxDaysAhead * DAY_MS;
}

import { describe, it, expect } from 'vitest';
import { RELIABILITY_EVENT_TYPES, SEVERITY_BY_TYPE, cancellationSeverity, isLateRequesterCancellation } from './reliability.rules.js';

describe('reliability rules (Backend PRD 21.1)', () => {
  it('classifies every event type except cancellations, which depend on the stage', () => {
    for (const type of RELIABILITY_EVENT_TYPES) {
      if (type === 'ASSIGNMENT_CANCELLED') continue;
      expect(SEVERITY_BY_TYPE[type], type).toBeDefined();
    }
  });

  it('follows the severity table', () => {
    expect(SEVERITY_BY_TYPE.ASSIGNMENT_TIMEOUT).toBe('LOW');
    expect(SEVERITY_BY_TYPE.ASSIGNMENT_DECLINED).toBe('LOW');
    expect(SEVERITY_BY_TYPE.LATE_CANCELLATION).toBe('MEDIUM');
    expect(SEVERITY_BY_TYPE.NO_RESPONSE_AFTER_ACCEPT).toBe('MEDIUM');
    expect(SEVERITY_BY_TYPE.VALID_REPORT_UPHELD).toBe('MEDIUM');
    expect(SEVERITY_BY_TYPE.NO_SHOW).toBe('HIGH');
    expect(SEVERITY_BY_TYPE.FALSE_NON_COMPLETION_CLAIM).toBe('HIGH');
  });

  it('gives positive and neutral facts no points', () => {
    for (const type of ['OFFER_SUBMITTED', 'ASSIGNMENT_ACCEPTED', 'ERRAND_COMPLETED', 'ERRAND_AUTO_COMPLETED', 'DELIVERY_CONFIRMED'] as const) {
      expect(SEVERITY_BY_TYPE[type], type).toBe('NONE');
    }
  });

  it('weighs a cancellation by the stage it happened at', () => {
    expect(cancellationSeverity('RUNNER_SELECTED')).toBe('NONE');
    expect(cancellationSeverity('ACCEPTED')).toBe('LOW');
    expect(cancellationSeverity('IN_PROGRESS')).toBe('MEDIUM');
    expect(cancellationSeverity('PICKED_UP')).toBe('HIGH');
    expect(cancellationSeverity('DELIVERED')).toBe('HIGH');
    expect(cancellationSeverity(null)).toBe('NONE');
  });

  it('calls a requester cancellation late from one hour before the start', () => {
    const scheduledAt = new Date('2026-10-12T12:00:00Z');
    const at = (iso: string) => ({ scheduledAt, cancelledAt: new Date(iso), leadMinutes: 60 });
    expect(isLateRequesterCancellation(at('2026-10-12T10:59:59Z'))).toBe(false);
    expect(isLateRequesterCancellation(at('2026-10-12T11:00:00Z'))).toBe(true);
    expect(isLateRequesterCancellation(at('2026-10-12T12:30:00Z'))).toBe(true);
    expect(isLateRequesterCancellation({ scheduledAt: null, cancelledAt: new Date(), leadMinutes: 60 })).toBe(false);
  });
});

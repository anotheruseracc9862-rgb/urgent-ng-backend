import { describe, it, expect } from 'vitest';
import { addDays, boostWindow, gatewayEmail, nextProPeriod, paymentReference, refundNeedsFourEyes, vatPortion } from './billing.rules.js';

describe('billing rules (Backend PRD 22)', () => {
  it('takes the VAT out of a VAT-inclusive price at 7.5 percent', () => {
    expect(vatPortion(100_000, 7.5)).toBe(6977); // 1,000 naira: 69.77 of VAT
    expect(vatPortion(500_000, 7.5)).toBe(34884);
    expect(vatPortion(0, 7.5)).toBe(0);
    expect(vatPortion(100_000, 0)).toBe(0);
  });

  it('builds a reference from the order and a random tail, with no personal data', () => {
    const ref = paymentReference('01a12c87-25b3-7ee3-b0da-569b3e4b2257', 'ab12cd34');
    expect(ref).toBe('UNG-569b3e4b2257-ab12cd34');
  });

  it('uses the account email, or a stable placeholder for a phone-only account', () => {
    expect(gatewayEmail({ id: 'u1', email: 'ada@example.com' })).toBe('ada@example.com');
    expect(gatewayEmail({ id: 'u1', email: null })).toBe('u1@pay.urgent.ng');
    expect(gatewayEmail({ id: 'u1', email: 'runner@demo.urgent.test' })).toBe('u1@pay.urgent.ng');
  });

  it('starts a Pro period now, or extends the one still running', () => {
    const now = new Date('2026-10-11T10:00:00Z');
    expect(nextProPeriod({ now, currentEnd: null, days: 30 })).toEqual({ start: now, end: addDays(now, 30) });
    const lapsed = new Date('2026-10-01T00:00:00Z');
    expect(nextProPeriod({ now, currentEnd: lapsed, days: 30 }).start).toEqual(now);
    const running = new Date('2026-10-20T00:00:00Z');
    const extended = nextProPeriod({ now, currentEnd: running, days: 30 });
    expect(extended.start).toEqual(running);
    expect(extended.end).toEqual(addDays(running, 30));
  });

  it('caps a boost at its length and at the errand deadline', () => {
    const now = new Date('2026-10-11T10:00:00Z');
    expect(boostWindow({ now, maxHours: 24, errandExpiresAt: null })?.expiresAt).toEqual(new Date('2026-10-12T10:00:00Z'));
    expect(boostWindow({ now, maxHours: 24, errandExpiresAt: new Date('2026-10-11T16:00:00Z') })?.expiresAt).toEqual(
      new Date('2026-10-11T16:00:00Z'),
    );
    expect(boostWindow({ now, maxHours: 24, errandExpiresAt: new Date('2026-10-11T09:00:00Z') })).toBeNull();
  });

  it('asks a second admin at or above the threshold', () => {
    expect(refundNeedsFourEyes(1_999_999, 2_000_000)).toBe(false);
    expect(refundNeedsFourEyes(2_000_000, 2_000_000)).toBe(true);
  });
});

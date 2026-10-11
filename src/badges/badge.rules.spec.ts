import { describe, it, expect } from 'vitest';
import { evaluateBadges, medianMinutes, sortForDisplay, type BadgeMetrics, type BadgeName, type BadgeThresholds } from './badge.rules.js';

const t: BadgeThresholds = {
  newBelowCompleted: 5,
  trustedMinCompleted: 25,
  trustedMinRatings: 10,
  ratingEarn: 4.5,
  ratingKeep: 4.3,
  trustedMaxCancellationPercent: 5,
  fastResponderMaxMinutes: 10,
  fastResponderMinSamples: 5,
  newRequesterBelowCompleted: 3,
  promptPayerMinCompleted: 5,
  promptPayerMinRatings: 5,
};

const base: BadgeMetrics = {
  isRunner: true,
  runnerCompleted: 30,
  runnerQualifyingCompleted: 30,
  distinctRaters: 12,
  ratingAverage: 4.8,
  cancellationPercent: 0,
  hasRecentHighSeverity: false,
  hasActiveRestriction: false,
  medianResponseMinutes: 4,
  responseSamples: 20,
  isPro: false,
  hasPostedErrand: true,
  requesterCompleted: 10,
  requesterQualifyingCompleted: 10,
  paymentConductCount: 8,
  paymentConductAverage: 4.9,
  hasUpheldNonPaymentRecently: false,
};
const none = new Set<BadgeName>();
const eval_ = (over: Partial<BadgeMetrics>, held: BadgeName[] = [], removed: BadgeName[] = []) =>
  evaluateBadges({ ...base, ...over }, t, new Set(held), new Set(removed));

describe('badge rules (Backend PRD 21.5)', () => {
  it('NEW is for a runner under 5 completed errands and goes at 5', () => {
    expect(eval_({ runnerCompleted: 4, runnerQualifyingCompleted: 4 }).has('NEW')).toBe(true);
    expect(eval_({ runnerCompleted: 5 }).has('NEW')).toBe(false);
    expect(eval_({ isRunner: false, runnerCompleted: 0 }).has('NEW')).toBe(false);
  });

  it('TRUSTED needs every condition', () => {
    expect(eval_({}).has('TRUSTED')).toBe(true);
    expect(eval_({ runnerQualifyingCompleted: 24 }).has('TRUSTED')).toBe(false);
    expect(eval_({ distinctRaters: 9 }).has('TRUSTED')).toBe(false);
    expect(eval_({ ratingAverage: 4.49 }).has('TRUSTED')).toBe(false);
    expect(eval_({ cancellationPercent: 5.01 }).has('TRUSTED')).toBe(false);
    expect(eval_({ cancellationPercent: 5 }).has('TRUSTED')).toBe(true);
    expect(eval_({ cancellationPercent: null }).has('TRUSTED')).toBe(false);
    expect(eval_({ hasRecentHighSeverity: true }).has('TRUSTED')).toBe(false);
    expect(eval_({ hasActiveRestriction: true }).has('TRUSTED')).toBe(false);
  });

  it('does not flap: earn at 4.5, keep until below 4.3', () => {
    expect(eval_({ ratingAverage: 4.4 }).has('TRUSTED')).toBe(false);
    expect(eval_({ ratingAverage: 4.4 }, ['TRUSTED']).has('TRUSTED')).toBe(true);
    expect(eval_({ ratingAverage: 4.3 }, ['TRUSTED']).has('TRUSTED')).toBe(true);
    expect(eval_({ ratingAverage: 4.29 }, ['TRUSTED']).has('TRUSTED')).toBe(false);
  });

  it('FAST_RESPONDER needs a sample and a median under 10 minutes', () => {
    expect(eval_({}).has('FAST_RESPONDER')).toBe(true);
    expect(eval_({ medianResponseMinutes: 10 }).has('FAST_RESPONDER')).toBe(false);
    expect(eval_({ responseSamples: 4 }).has('FAST_RESPONDER')).toBe(false);
    expect(eval_({ medianResponseMinutes: null }).has('FAST_RESPONDER')).toBe(false);
  });

  it('PRO follows an active subscription', () => {
    expect(eval_({ isPro: true }).has('PRO')).toBe(true);
    expect(eval_({ isPro: false }).has('PRO')).toBe(false);
  });

  it('NEW_REQUESTER is for a requester with a posted errand and under 3 completed', () => {
    expect(eval_({ requesterCompleted: 2 }).has('NEW_REQUESTER')).toBe(true);
    expect(eval_({ requesterCompleted: 3 }).has('NEW_REQUESTER')).toBe(false);
    expect(eval_({ requesterCompleted: 0, hasPostedErrand: false }).has('NEW_REQUESTER')).toBe(false);
  });

  it('PROMPT_PAYER needs completions, ratings, a good average and no upheld non-payment report', () => {
    expect(eval_({}).has('PROMPT_PAYER')).toBe(true);
    expect(eval_({ requesterQualifyingCompleted: 4 }).has('PROMPT_PAYER')).toBe(false);
    expect(eval_({ paymentConductCount: 4 }).has('PROMPT_PAYER')).toBe(false);
    expect(eval_({ paymentConductAverage: 4.4 }).has('PROMPT_PAYER')).toBe(false);
    expect(eval_({ paymentConductAverage: 4.4 }, ['PROMPT_PAYER']).has('PROMPT_PAYER')).toBe(true);
    expect(eval_({ hasUpheldNonPaymentRecently: true }).has('PROMPT_PAYER')).toBe(false);
  });

  it('an active badge removal keeps that badge off', () => {
    const result = eval_({}, [], ['TRUSTED']);
    expect(result.has('TRUSTED')).toBe(false);
    expect(result.has('FAST_RESPONDER')).toBe(true);
  });

  it('holds nothing for a user with no history', () => {
    const empty = evaluateBadges(
      { ...base, isRunner: false, runnerCompleted: 0, runnerQualifyingCompleted: 0, distinctRaters: 0, ratingAverage: null, cancellationPercent: null,
        medianResponseMinutes: null, responseSamples: 0, hasPostedErrand: false, requesterCompleted: 0, requesterQualifyingCompleted: 0,
        paymentConductCount: 0, paymentConductAverage: null },
      t,
      none,
      none,
    );
    expect([...empty]).toEqual([]);
  });

  it('medians count an unanswered conversation as slower than any answer', () => {
    expect(medianMinutes([])).toBeNull();
    expect(medianMinutes([2, 4, 6])).toBe(4);
    expect(medianMinutes([2, 4, 6, 8])).toBe(5);
    expect(medianMinutes([1, 2, null])).toBe(2);
    expect(medianMinutes([null, null, 3])).toBeNull();
  });

  it('orders badges for display, strongest trust signal first', () => {
    expect(sortForDisplay(['NEW', 'PRO', 'TRUSTED'])).toEqual(['TRUSTED', 'PRO', 'NEW']);
  });
});

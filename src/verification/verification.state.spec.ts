import { describe, it, expect } from 'vitest';
import type { VerificationStatus } from '@prisma/client';
import { canTransition, displayStatus, VERIFICATION_TRANSITIONS } from './verification.state.js';

const ALL: VerificationStatus[] = ['NOT_STARTED', 'PENDING', 'VERIFIED', 'FAILED', 'EXPIRED', 'REVOKED', 'REVIEW_REQUIRED'];

describe('verification state machine', () => {
  const allowed: Array<[VerificationStatus, VerificationStatus]> = [
    ['NOT_STARTED', 'PENDING'],
    ['PENDING', 'VERIFIED'],
    ['PENDING', 'FAILED'],
    ['PENDING', 'REVIEW_REQUIRED'],
    ['REVIEW_REQUIRED', 'VERIFIED'],
    ['REVIEW_REQUIRED', 'FAILED'],
    ['FAILED', 'VERIFIED'],
    ['VERIFIED', 'EXPIRED'],
    ['VERIFIED', 'REVOKED'],
  ];

  it.each(allowed)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('allows nothing else', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const expected = allowed.some(([a, b]) => a === from && b === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('EXPIRED and REVOKED are final, and every status has an entry', () => {
    expect(VERIFICATION_TRANSITIONS.EXPIRED).toEqual([]);
    expect(VERIFICATION_TRANSITIONS.REVOKED).toEqual([]);
    expect(Object.keys(VERIFICATION_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it('shows PENDING and REVIEW_REQUIRED as Pending, FAILED and REVOKED as Rejected', () => {
    expect(displayStatus('PENDING')).toBe('PENDING');
    expect(displayStatus('REVIEW_REQUIRED')).toBe('PENDING');
    expect(displayStatus('FAILED')).toBe('REJECTED');
    expect(displayStatus('REVOKED')).toBe('REJECTED');
    expect(displayStatus('VERIFIED')).toBe('VERIFIED');
    expect(displayStatus('EXPIRED')).toBe('EXPIRED');
    expect(displayStatus('NOT_STARTED')).toBe('NOT_STARTED');
  });
});

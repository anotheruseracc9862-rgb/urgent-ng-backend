import { describe, it, expect } from 'vitest';
import { levelsReached, ladderReason } from './enforcement.rules.js';

const thresholds = { warning: 4, restriction: 8, suspension: 12, adminReview: 16 };

describe('enforcement ladder (Backend PRD 21.4)', () => {
  it('reaches no level below the warning threshold', () => {
    expect(levelsReached(0, thresholds)).toEqual([]);
    expect(levelsReached(3, thresholds)).toEqual([]);
  });

  it('reaches each level exactly at its threshold, cumulatively', () => {
    expect(levelsReached(4, thresholds)).toEqual(['WARNING']);
    expect(levelsReached(7, thresholds)).toEqual(['WARNING']);
    expect(levelsReached(8, thresholds)).toEqual(['WARNING', 'RESTRICTION']);
    expect(levelsReached(12, thresholds)).toEqual(['WARNING', 'RESTRICTION', 'SUSPENSION']);
    expect(levelsReached(16, thresholds)).toEqual(['WARNING', 'RESTRICTION', 'SUSPENSION', 'ADMIN_REVIEW']);
    expect(levelsReached(40, thresholds)).toHaveLength(4);
  });

  it('follows changed thresholds', () => {
    expect(levelsReached(5, { warning: 2, restriction: 5, suspension: 9, adminReview: 20 })).toEqual(['WARNING', 'RESTRICTION']);
  });

  it('words the user-facing reason without naming anyone', () => {
    expect(ladderReason('WARNING', 4, 90)).toContain('4 reliability points');
    expect(ladderReason('RESTRICTION', 8, 90)).toContain('paused');
    expect(ladderReason('SUSPENSION', 12, 90)).toContain('suspended');
  });
});

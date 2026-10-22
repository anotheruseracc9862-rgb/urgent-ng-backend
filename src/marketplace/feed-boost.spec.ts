import { describe, expect, it } from 'vitest';
import { PIN_ROTATION_MINUTES, pinRotationBucket, rotatePinned } from './feed-boost.hook.js';

const rows = Array.from({ length: 8 }, (_, index) => ({ id: `errand-${index}` }));

describe('rotatePinned', () => {
  it('gives every boosted errand a turn over time, not the same few every time', () => {
    const seen = new Set<string>();
    for (let bucket = 0; bucket < 60; bucket += 1) rotatePinned(rows, 3, bucket).forEach((row) => seen.add(row.id));
    expect(seen.size).toBe(rows.length);
  });

  it('is fixed within a window, so paging does not shuffle the pinned errands', () => {
    expect(rotatePinned(rows, 3, 42).map((row) => row.id)).toEqual(rotatePinned(rows, 3, 42).map((row) => row.id));
  });

  it('keeps the order the runner sorted by, and never gives more slots than there are', () => {
    const chosen = rotatePinned(rows, 3, 7);
    expect(chosen).toHaveLength(3);
    expect(chosen.map((row) => row.id)).toEqual(rows.filter((row) => chosen.some((c) => c.id === row.id)).map((row) => row.id));
  });

  it('leaves the list alone when everything fits', () => {
    expect(rotatePinned(rows.slice(0, 3), 3, 1)).toEqual(rows.slice(0, 3));
    expect(rotatePinned([], 3, 1)).toEqual([]);
  });
});

describe('pinRotationBucket', () => {
  it('changes every ' + PIN_ROTATION_MINUTES + ' minutes', () => {
    const start = new Date('2026-10-22T10:00:00.000Z');
    expect(pinRotationBucket(new Date(start.getTime() + 5 * 60_000))).toBe(pinRotationBucket(start));
    expect(pinRotationBucket(new Date(start.getTime() + PIN_ROTATION_MINUTES * 60_000))).toBe(pinRotationBucket(start) + 1);
  });
});

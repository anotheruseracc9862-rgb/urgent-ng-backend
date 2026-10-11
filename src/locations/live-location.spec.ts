import { describe, it, expect } from 'vitest';
import { freshnessOf, roundToGrid } from './live-location.js';

describe('live location helpers (Backend PRD 17.3)', () => {
  it('labels age: fresh under 5 minutes, stale to 30, expired beyond', () => {
    expect(freshnessOf(null, 5, 30)).toBe('NONE');
    expect(freshnessOf(0, 5, 30)).toBe('FRESH');
    expect(freshnessOf(299, 5, 30)).toBe('FRESH');
    expect(freshnessOf(300, 5, 30)).toBe('STALE');
    expect(freshnessOf(1799, 5, 30)).toBe('STALE');
    expect(freshnessOf(1800, 5, 30)).toBe('EXPIRED');
  });

  it('gives every position inside a cell the same rounded point', () => {
    const a = roundToGrid({ lat: 6.52441, lng: 3.37921 }, 250);
    const b = roundToGrid({ lat: 6.52445, lng: 3.37925 }, 250);
    expect(a).toEqual(b);
  });

  it('keeps the rounded point within the cell, never on the exact spot by design', () => {
    const exact = { lat: 6.5244, lng: 3.3792 };
    const rounded = roundToGrid(exact, 250);
    const dLat = Math.abs(rounded.lat - exact.lat) * 111_320;
    const dLng = Math.abs(rounded.lng - exact.lng) * 111_320 * Math.cos((exact.lat * Math.PI) / 180);
    expect(dLat).toBeLessThanOrEqual(125 + 1);
    expect(dLng).toBeLessThanOrEqual(125 + 1);
  });

  it('moves to a different point when the runner crosses into another cell', () => {
    const a = roundToGrid({ lat: 6.5244, lng: 3.3792 }, 250);
    const b = roundToGrid({ lat: 6.5344, lng: 3.3792 }, 250);
    expect(a).not.toEqual(b);
  });

  it('uses a coarser grid for a coarser setting', () => {
    const fine = roundToGrid({ lat: 6.5244, lng: 3.3792 }, 250);
    const coarse = roundToGrid({ lat: 6.5244, lng: 3.3792 }, 1000);
    const nearby = roundToGrid({ lat: 6.5254, lng: 3.3797 }, 1000);
    expect(coarse).toEqual(nearby);
    expect(fine).not.toEqual(coarse);
  });
});

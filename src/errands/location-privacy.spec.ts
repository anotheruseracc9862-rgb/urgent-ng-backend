import { approximatePoint, distanceBucket, haversineMeters, isValidPoint, type LatLng } from './location-privacy.js';

const SECRET = 'a-test-secret-with-enough-length-0123456789';
const OPTIONS = { gridMeters: 500, maxOffsetMeters: 250 };
const LAGOS: LatLng = { lat: 6.5244, lng: 3.3792 };
const ERRAND = '0192f0f0-0000-7000-8000-000000000001';

/** A cheap deterministic pseudo-random sequence so the tests are repeatable. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('approximatePoint', () => {
  it('is stable: the same errand and place always give the same point', () => {
    const a = approximatePoint(LAGOS, ERRAND, 'ERRAND_PICKUP', SECRET, OPTIONS);
    const b = approximatePoint(LAGOS, ERRAND, 'ERRAND_PICKUP', SECRET, OPTIONS);
    expect(a).toEqual(b);
  });

  it('never returns the exact point', () => {
    expect(approximatePoint(LAGOS, ERRAND, 'ERRAND_PICKUP', SECRET, OPTIONS)).not.toEqual(LAGOS);
  });

  it('stays within the grid and offset of the exact point', () => {
    const random = sequence(7);
    // Half the cell diagonal plus the largest offset is the furthest the answer can be.
    const limit = Math.hypot(250, 250) + 250 + 5;
    for (let i = 0; i < 500; i += 1) {
      const exact = { lat: 6.4 + random() * 0.3, lng: 3.2 + random() * 0.4 };
      const approx = approximatePoint(exact, `errand-${i}`, 'ERRAND_PICKUP', SECRET, OPTIONS);
      expect(haversineMeters(exact, approx)).toBeLessThanOrEqual(limit);
    }
  });

  it('cannot be narrowed below the grid size by probing (Backend PRD 17.2)', () => {
    // Put the errand at 400 different exact places inside one 500 m cell. An observer who sees
    // the approximate point cannot tell them apart: every answer is identical.
    const latStep = 500 / 111_320;
    const baseLat = (Math.floor(6.5244 / latStep) + 0.25) * latStep;
    const lngStep = 500 / (111_320 * Math.cos((baseLat * Math.PI) / 180));
    const baseLng = (Math.floor(3.3792 / lngStep) + 0.05) * lngStep;
    const random = sequence(11);
    const answers = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      const exact = { lat: baseLat + random() * latStep * 0.9, lng: baseLng + random() * lngStep * 0.9 };
      const approx = approximatePoint(exact, ERRAND, 'ERRAND_PICKUP', SECRET, OPTIONS);
      answers.add(`${approx.lat.toFixed(9)},${approx.lng.toFixed(9)}`);
    }
    // At most two cells can be crossed by the 0.9 cell wide sample; never 400 distinct answers.
    expect(answers.size).toBeLessThanOrEqual(4);
  });

  it('gives different errands in the same cell different points (offset is per errand)', () => {
    const points = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const approx = approximatePoint(LAGOS, `errand-${i}`, 'ERRAND_PICKUP', SECRET, OPTIONS);
      points.add(`${approx.lat.toFixed(7)},${approx.lng.toFixed(7)}`);
    }
    expect(points.size).toBeGreaterThan(40);
  });

  it('moves pickup and destination of one errand independently', () => {
    const pickup = approximatePoint(LAGOS, ERRAND, 'ERRAND_PICKUP', SECRET, OPTIONS);
    const dropoff = approximatePoint(LAGOS, ERRAND, 'ERRAND_DESTINATION', SECRET, OPTIONS);
    expect(pickup).not.toEqual(dropoff);
  });

  it('cannot be reproduced without the secret', () => {
    const real = approximatePoint(LAGOS, ERRAND, 'ERRAND_PICKUP', SECRET, OPTIONS);
    const guessed = approximatePoint(LAGOS, ERRAND, 'ERRAND_PICKUP', 'another-secret-of-similar-length-987654321', OPTIONS);
    expect(guessed).not.toEqual(real);
  });

  it('respects a smaller offset and grid from configuration', () => {
    const approx = approximatePoint(LAGOS, ERRAND, 'ERRAND_PICKUP', SECRET, { gridMeters: 200, maxOffsetMeters: 0 });
    // No offset: the answer is the cell centre, no more than half a cell diagonal away.
    expect(haversineMeters(LAGOS, approx)).toBeLessThanOrEqual(Math.hypot(100, 100) + 5);
  });

  it('keeps the latitude on the map near the poles', () => {
    const approx = approximatePoint({ lat: 89.99, lng: 10 }, ERRAND, 'ERRAND_PICKUP', SECRET, OPTIONS);
    expect(isValidPoint(approx)).toBe(true);
  });
});

describe('distanceBucket', () => {
  it.each([
    [0, 0.5, '< 0.5 km'],
    [499, 0.5, '< 0.5 km'],
    [500, 1, '< 1 km'],
    [999, 1, '< 1 km'],
    [1000, 1.5, '< 1.5 km'],
    [2300, 2.5, '< 2.5 km'],
    [4999, 5, '< 5 km'],
    [5000, 6, '< 6 km'],
    [5999, 6, '< 6 km'],
    [12_400, 13, '< 13 km'],
  ])('%d m is "%s"', (meters, upperKm, label) => {
    expect(distanceBucket(meters)).toEqual({ upperKm, label });
  });

  it('treats a negative distance as zero', () => {
    expect(distanceBucket(-5).upperKm).toBe(0.5);
  });
});

describe('haversineMeters', () => {
  it('is zero for the same point and roughly right for a known pair', () => {
    expect(haversineMeters(LAGOS, LAGOS)).toBe(0);
    // Ikeja to Lekki is about 18 to 22 km.
    const km = haversineMeters({ lat: 6.6018, lng: 3.3515 }, { lat: 6.4474, lng: 3.4723 }) / 1000;
    expect(km).toBeGreaterThan(18);
    expect(km).toBeLessThan(23);
  });
});

describe('isValidPoint', () => {
  it('accepts real coordinates and rejects the rest', () => {
    expect(isValidPoint(LAGOS)).toBe(true);
    expect(isValidPoint({ lat: 91, lng: 0 })).toBe(false);
    expect(isValidPoint({ lat: 0, lng: 181 })).toBe(false);
    expect(isValidPoint({ lat: Number.NaN, lng: 0 })).toBe(false);
  });
});

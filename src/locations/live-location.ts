/**
 * Pure helpers for the live view (Backend PRD 17.3, 17.4): how old a location is, and the rounded
 * point a reader may see instead of the exact one.
 */

export type Freshness = 'FRESH' | 'STALE' | 'EXPIRED' | 'NONE';

const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Fresh under `freshMinutes`, stale until `staleMinutes`, expired beyond. A stale or expired
 * location is never presented as live, and silence is not proof that the runner stopped moving.
 */
export function freshnessOf(ageSeconds: number | null, freshMinutes: number, staleMinutes: number): Freshness {
  if (ageSeconds === null) return 'NONE';
  if (ageSeconds < freshMinutes * 60) return 'FRESH';
  if (ageSeconds < staleMinutes * 60) return 'STALE';
  return 'EXPIRED';
}

/**
 * The centre of the grid cell (about `gridMeters` across) that contains the point. Every exact
 * position inside one cell gives the same answer, so a reader cannot narrow it by watching.
 */
export function roundToGrid(point: { lat: number; lng: number }, gridMeters: number): { lat: number; lng: number } {
  const latStep = gridMeters / METERS_PER_DEGREE_LAT;
  const cell = Math.floor(point.lat / latStep);
  const centreLat = (cell + 0.5) * latStep;
  // Longitude degrees shrink with latitude; use the cell's own latitude so the cell stays about square.
  const lngStep = gridMeters / (METERS_PER_DEGREE_LAT * Math.max(0.01, Math.cos((centreLat * Math.PI) / 180)));
  const lngCell = Math.floor(point.lng / lngStep);
  return { lat: round6(centreLat), lng: round6((lngCell + 0.5) * lngStep) };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

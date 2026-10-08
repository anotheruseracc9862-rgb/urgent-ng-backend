import { createHmac } from 'node:crypto';

/**
 * Approximate errand locations (Backend PRD 17.2). Pure functions, no database.
 *
 * Why this exists: an exact distance and a "nearest" sort would let a runner probe an errand from
 * several positions and triangulate the pickup address. So every errand gets one stable
 * approximate point, and every distance is measured from that point and rounded into a bucket.
 *
 * The approximate point is the centre of a grid cell (about 500 m wide) that holds the exact
 * point, moved by a private offset of up to 250 m. Every exact point inside one cell gives the
 * same answer, so no number of probes can narrow an errand below the cell size. The offset comes
 * from HMAC(secret, errand id and location type): it is fixed per errand, and a reader who does
 * not know the secret cannot undo it, which hides where in the cell (and next to which border) the
 * errand really is.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface ApproximationOptions {
  /** Width of a grid cell in metres. */
  gridMeters: number;
  /** Largest offset from the cell centre, in metres. */
  maxOffsetMeters: number;
}

const METERS_PER_DEGREE_LAT = 111_320;
const EARTH_RADIUS_METERS = 6_371_000;
const MAX_LAT = 89.9; // keeps cos(lat) away from zero

const clampLat = (lat: number): number => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

/** Two uniform numbers in [0, 1) that only the secret holder can predict. */
function offsetSeed(secret: string, errandId: string, locationType: string): { u: number; v: number } {
  const digest = createHmac('sha256', secret).update(`errand-offset:${errandId}:${locationType}`).digest();
  return {
    u: digest.readUInt32BE(0) / 2 ** 32,
    v: digest.readUInt32BE(4) / 2 ** 32,
  };
}

export function approximatePoint(
  exact: LatLng,
  errandId: string,
  locationType: string,
  secret: string,
  options: ApproximationOptions,
): LatLng {
  const grid = Math.max(1, options.gridMeters);
  const latStep = grid / METERS_PER_DEGREE_LAT;
  const snappedLat = (Math.floor(clampLat(exact.lat) / latStep) + 0.5) * latStep;
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos((snappedLat * Math.PI) / 180);
  const lngStep = grid / metersPerDegreeLng;
  const snappedLng = (Math.floor(exact.lng / lngStep) + 0.5) * lngStep;

  const { u, v } = offsetSeed(secret, errandId, locationType);
  const radius = Math.max(0, options.maxOffsetMeters) * Math.sqrt(u); // uniform over the disc
  const angle = 2 * Math.PI * v;
  return {
    lat: clampLat(snappedLat + (radius * Math.sin(angle)) / METERS_PER_DEGREE_LAT),
    lng: snappedLng + (radius * Math.cos(angle)) / metersPerDegreeLng,
  };
}

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface DistanceBucket {
  /** The distance is below this many km. */
  upperKm: number;
  label: string;
}

/**
 * "< 0.5 km", then 0.5 km steps up to 5 km, then 1 km steps. The bucket is the smallest step
 * that is above the distance, so 0.5 km exactly reads "< 1 km".
 */
export function distanceBucket(meters: number): DistanceBucket {
  const km = Math.max(0, meters) / 1000;
  const upperKm = km < 0.5 ? 0.5 : km < 5 ? (Math.floor(km / 0.5) + 1) * 0.5 : Math.floor(km) + 1;
  return { upperKm, label: `< ${upperKm} km` };
}

/** Whether the point lies on the map at all. */
export function isValidPoint(point: LatLng): boolean {
  return Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
}

/**
 * Maps/geocoding provider interface
 */

export interface GeocodeResult {
  success: boolean;
  latitude?: number;
  longitude?: number;
  formattedAddress?: string;
  error?: string;
}

export interface ReverseGeocodeResult {
  success: boolean;
  address?: string;
  /** Neighbourhood or district, for example "Yaba". Shown in feeds instead of the address. */
  area?: string;
  /** Local government area, for example "Lagos Mainland". */
  lga?: string;
  city?: string;
  state?: string;
  error?: string;
}

export interface DistanceResult {
  success: boolean;
  distanceMeters?: number;
  durationSeconds?: number;
  /** True only when durationSeconds already accounts for live traffic. */
  trafficAware?: boolean;
  error?: string;
}

export interface IMapsProvider {
  /**
   * Convert address to coordinates
   */
  geocode(address: string): Promise<GeocodeResult>;

  /**
   * Convert coordinates to address
   */
  reverseGeocode(latitude: number, longitude: number): Promise<ReverseGeocodeResult>;

  /**
   * Calculate distance between two points
   */
  calculateDistance(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
  ): Promise<DistanceResult>;
}

export const MAPS_PROVIDER = Symbol('MAPS_PROVIDER');

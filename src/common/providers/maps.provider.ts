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
  city?: string;
  state?: string;
  error?: string;
}

export interface DistanceResult {
  success: boolean;
  distanceMeters?: number;
  durationSeconds?: number;
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

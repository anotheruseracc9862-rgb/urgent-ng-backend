import { ProviderError } from './provider.error.js';
import type { DistanceResult, GeocodeResult, IMapsProvider, ReverseGeocodeResult } from './maps.provider.js';

export interface GoogleMapsSettings {
  /** A server key. Restrict it by IP and to the Geocoding and Distance Matrix APIs. */
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

type FetchLike = typeof fetch;

interface AddressComponent {
  long_name: string;
  types: string[];
}

/**
 * Google Maps Platform adapter: Geocoding and Distance Matrix over HTTPS, no SDK. A place that
 * cannot be found is a result (`success: false`); a network error, a timeout or a 5xx is a
 * `ProviderError` so the caller can retry.
 */
export class GoogleMapsProvider implements IMapsProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly settings: GoogleMapsSettings,
    options: { fetchImpl?: FetchLike } = {},
  ) {
    this.baseUrl = settings.baseUrl ?? 'https://maps.googleapis.com/maps/api';
    this.timeoutMs = settings.timeoutMs ?? 8000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async geocode(address: string): Promise<GeocodeResult> {
    const body = await this.get('geocode/json', { address, region: 'ng', components: 'country:NG' });
    const status = body.status as string;
    if (status === 'ZERO_RESULTS') return { success: false, error: 'No match for this address.' };
    if (status !== 'OK') return this.failure(status, body);
    const first = (body.results as Array<{ geometry: { location: { lat: number; lng: number } }; formatted_address: string }>)[0];
    return {
      success: true,
      latitude: first.geometry.location.lat,
      longitude: first.geometry.location.lng,
      formattedAddress: first.formatted_address,
    };
  }

  async reverseGeocode(latitude: number, longitude: number): Promise<ReverseGeocodeResult> {
    const body = await this.get('geocode/json', { latlng: `${latitude},${longitude}`, region: 'ng' });
    const status = body.status as string;
    if (status === 'ZERO_RESULTS') return { success: false, error: 'No address for this point.' };
    if (status !== 'OK') return this.failure(status, body);
    const results = body.results as Array<{ formatted_address: string; address_components: AddressComponent[] }>;
    const components = results.flatMap((result) => result.address_components);
    const pick = (...types: string[]) => {
      for (const type of types) {
        const found = components.find((component) => component.types.includes(type));
        if (found) return found.long_name;
      }
      return undefined;
    };
    return {
      success: true,
      address: results[0].formatted_address,
      // Lagos neighbourhoods are usually "sublocality" or "neighborhood"; fall back to the locality.
      area: pick('sublocality_level_1', 'sublocality', 'neighborhood', 'locality'),
      lga: pick('administrative_area_level_2'),
      city: pick('locality', 'administrative_area_level_2'),
      state: pick('administrative_area_level_1')?.replace(/ State$/, ''),
    };
  }

  async calculateDistance(fromLat: number, fromLng: number, toLat: number, toLng: number): Promise<DistanceResult> {
    const body = await this.get('distancematrix/json', {
      origins: `${fromLat},${fromLng}`,
      destinations: `${toLat},${toLng}`,
      departure_time: 'now',
      mode: 'driving',
    });
    const status = body.status as string;
    if (status !== 'OK') return this.failure(status, body);
    const element = (body.rows as Array<{ elements: Array<Record<string, any>> }>)[0]?.elements[0];
    if (!element || element.status !== 'OK') return { success: false, error: 'No route between these points.' };
    const inTraffic = element.duration_in_traffic as { value: number } | undefined;
    return {
      success: true,
      distanceMeters: element.distance.value as number,
      durationSeconds: (inTraffic ?? element.duration).value as number,
      trafficAware: inTraffic !== undefined,
    };
  }

  private async get(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ ...params, key: this.settings.apiKey });
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${path}?${query.toString()}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new ProviderError('maps', 'Could not reach Google Maps.', { retryable: true, cause: error });
    }
    if (response.status >= 500 || response.status === 429) {
      throw new ProviderError('maps', `Google Maps answered ${response.status}.`, { retryable: true });
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.status !== 'string') {
      throw new ProviderError('maps', 'Google Maps sent an answer that could not be read.', { retryable: false });
    }
    return body;
  }

  /** OVER_QUERY_LIMIT and UNKNOWN_ERROR can pass; a denied or invalid request is our configuration. */
  private failure(status: string, body: Record<string, unknown>): never {
    const retryable = status === 'OVER_QUERY_LIMIT' || status === 'UNKNOWN_ERROR';
    const detail = typeof body.error_message === 'string' ? ` ${body.error_message}` : '';
    throw new ProviderError('maps', `Google Maps answered ${status}.${detail}`, { retryable });
  }
}

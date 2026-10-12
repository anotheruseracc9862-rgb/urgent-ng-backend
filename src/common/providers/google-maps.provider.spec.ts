import { describe, it, expect } from 'vitest';
import { GoogleMapsProvider } from './google-maps.provider.js';
import { ProviderError } from './provider.error.js';

function provider(responses: Array<{ status?: number; json?: unknown; throws?: Error }>) {
  const urls: string[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const next = queue.shift() ?? { json: { status: 'OK' } };
    if (next.throws) throw next.throws;
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { urls, maps: new GoogleMapsProvider({ apiKey: 'KEY' }, { fetchImpl }) };
}

describe('GoogleMapsProvider', () => {
  it('geocodes an address inside Nigeria and sends the key', async () => {
    const { maps, urls } = provider([
      { json: { status: 'OK', results: [{ formatted_address: '1 Allen Ave, Ikeja', geometry: { location: { lat: 6.6, lng: 3.35 } } }] } },
    ]);
    expect(await maps.geocode('1 Allen Avenue')).toEqual({ success: true, latitude: 6.6, longitude: 3.35, formattedAddress: '1 Allen Ave, Ikeja' });
    expect(urls[0]).toContain('region=ng');
    expect(urls[0]).toContain('key=KEY');
  });

  it('answers "no match" as a result, not an error', async () => {
    const { maps } = provider([{ json: { status: 'ZERO_RESULTS', results: [] } }]);
    expect(await maps.geocode('zzzz')).toMatchObject({ success: false });
  });

  it('reads area, LGA, city and state from the address components', async () => {
    const { maps } = provider([
      {
        json: {
          status: 'OK',
          results: [
            {
              formatted_address: 'Herbert Macaulay Way, Yaba, Lagos',
              address_components: [
                { long_name: 'Yaba', types: ['sublocality_level_1', 'sublocality'] },
                { long_name: 'Lagos Mainland', types: ['administrative_area_level_2'] },
                { long_name: 'Lagos', types: ['locality'] },
                { long_name: 'Lagos State', types: ['administrative_area_level_1'] },
              ],
            },
          ],
        },
      },
    ]);
    expect(await maps.reverseGeocode(6.5, 3.38)).toEqual({
      success: true,
      address: 'Herbert Macaulay Way, Yaba, Lagos',
      area: 'Yaba',
      lga: 'Lagos Mainland',
      city: 'Lagos',
      state: 'Lagos',
    });
  });

  it('uses the traffic duration when Google gives one', async () => {
    const { maps } = provider([
      { json: { status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: 5200 }, duration: { value: 600 }, duration_in_traffic: { value: 900 } }] }] } },
      { json: { status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: 5200 }, duration: { value: 600 } }] }] } },
    ]);
    expect(await maps.calculateDistance(6.5, 3.3, 6.6, 3.4)).toEqual({ success: true, distanceMeters: 5200, durationSeconds: 900, trafficAware: true });
    expect(await maps.calculateDistance(6.5, 3.3, 6.6, 3.4)).toEqual({ success: true, distanceMeters: 5200, durationSeconds: 600, trafficAware: false });
  });

  it('throws a retryable ProviderError for a network failure, 5xx and a quota answer', async () => {
    const { maps } = provider([
      { throws: new Error('ECONNRESET') },
      { status: 503 },
      { json: { status: 'OVER_QUERY_LIMIT' } },
    ]);
    for (let i = 0; i < 3; i += 1) {
      await expect(maps.geocode('x')).rejects.toMatchObject({ name: 'ProviderError', options: { retryable: true } });
    }
  });

  it('throws a non-retryable ProviderError when the key is refused', async () => {
    const { maps } = provider([{ json: { status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.' } }]);
    const error = await maps.geocode('x').catch((e) => e as ProviderError);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as ProviderError).message).toContain('REQUEST_DENIED');
  });
});

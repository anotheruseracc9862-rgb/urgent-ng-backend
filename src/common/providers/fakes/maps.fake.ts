/**
 * Fake maps provider for testing
 */

import { Injectable } from '@nestjs/common';
import { BaseFake } from './base.fake.js';
import {
  IMapsProvider,
  GeocodeResult,
  ReverseGeocodeResult,
  DistanceResult,
} from '../maps.provider.js';

@Injectable()
export class FakeMapsProvider extends BaseFake implements IMapsProvider {
  async geocode(address: string): Promise<GeocodeResult> {
    this.recordCall('geocode', address);

    if (this.hasScriptedOutcome('geocode')) {
      return this.getNextOutcome<GeocodeResult>('geocode')!;
    }

    return {
      success: true,
      latitude: 6.5244,
      longitude: 3.3792,
      formattedAddress: address,
    };
  }

  async reverseGeocode(latitude: number, longitude: number): Promise<ReverseGeocodeResult> {
    this.recordCall('reverseGeocode', latitude, longitude);

    if (this.hasScriptedOutcome('reverseGeocode')) {
      return this.getNextOutcome<ReverseGeocodeResult>('reverseGeocode')!;
    }

    return {
      success: true,
      address: 'Fake Address, Lagos',
      area: 'Yaba',
      lga: 'Lagos Mainland',
      city: 'Lagos',
      state: 'Lagos',
    };
  }

  async calculateDistance(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
  ): Promise<DistanceResult> {
    this.recordCall('calculateDistance', fromLat, fromLng, toLat, toLng);

    if (this.hasScriptedOutcome('calculateDistance')) {
      return this.getNextOutcome<DistanceResult>('calculateDistance')!;
    }

    // Simple Haversine approximation for fake data
    const R = 6371e3; // Earth radius in meters
    const φ1 = (fromLat * Math.PI) / 180;
    const φ2 = (toLat * Math.PI) / 180;
    const Δφ = ((toLat - fromLat) * Math.PI) / 180;
    const Δλ = ((toLng - fromLng) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    return {
      success: true,
      distanceMeters: Math.round(distance),
      durationSeconds: Math.round(distance / 10), // Fake: 10 m/s average
    };
  }
}

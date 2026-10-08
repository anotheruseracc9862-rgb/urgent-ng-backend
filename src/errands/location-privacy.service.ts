import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LocationSource } from '@prisma/client';
import { BusinessConfigService } from '../config/business-config.service.js';
import { MAPS_PROVIDER, type IMapsProvider } from '../common/providers/maps.provider.js';
import { approximatePoint, distanceBucket, type LatLng } from './location-privacy.js';
import type { ErrandLocationRecord, ErrandLocationType, ErrandLocationWrite } from './errand-location.repository.js';

/** What a runner browsing the feed (or any stranger) may see of a location. */
export interface PublicLocationView {
  area: string;
  lga: string | null;
  state: string | null;
  /** The approximate point only (Backend PRD 17.2). */
  approx: LatLng;
}

/** What the requester, and the assigned runner once the assignment is accepted, may see. */
export interface ParticipantLocationView extends PublicLocationView {
  exact: LatLng;
  addressText: string | null;
  landmark: string | null;
}

export type LocationAccessLevel = 'PUBLIC' | 'PARTICIPANT';

const FALLBACK_AREA = 'Nigeria';

/**
 * Turns a map pin into what is stored (exact point, approximate point, area) and turns stored
 * locations into the view a given reader may see (Backend PRD 17.2). The frontend is never
 * trusted to hide anything: a public reader is simply never given the exact fields.
 */
@Injectable()
export class LocationPrivacyService {
  private readonly logger = new Logger(LocationPrivacyService.name);

  constructor(
    private readonly appConfig: ConfigService,
    private readonly config: BusinessConfigService,
    @Inject(MAPS_PROVIDER) private readonly maps: IMapsProvider,
  ) {}

  /**
   * The values to store for a pin. The area, LGA and state come from reverse geocoding; if the
   * maps provider fails the errand can still be saved, with a generic area (a pin and a landmark
   * are always enough to publish, Backend PRD 11.1).
   */
  async prepare(input: {
    errandId: string;
    type: ErrandLocationType;
    point: LatLng;
    addressText?: string | null;
    landmark?: string | null;
    source: LocationSource;
  }): Promise<ErrandLocationWrite> {
    const [gridMeters, maxOffsetMeters] = await Promise.all([
      this.config.get('APPROX_GRID_METERS'),
      this.config.get('APPROX_MAX_OFFSET_METERS'),
    ]);
    const approx = approximatePoint(
      input.point,
      input.errandId,
      input.type,
      this.appConfig.getOrThrow<string>('security.hmacSecret'),
      { gridMeters, maxOffsetMeters },
    );
    const place = await this.reverseGeocode(approx);
    return {
      errandId: input.errandId,
      type: input.type,
      exact: input.point,
      approx,
      addressText: input.addressText ?? null,
      landmark: input.landmark ?? null,
      area: place.area,
      lga: place.lga,
      state: place.state,
      source: input.source,
    };
  }

  /**
   * Geocode the approximate point, not the exact one, so the area name can never be finer than
   * what is already public.
   */
  private async reverseGeocode(point: LatLng): Promise<{ area: string; lga: string | null; state: string | null }> {
    try {
      const result = await this.maps.reverseGeocode(point.lat, point.lng);
      if (result.success) {
        return {
          area: result.area ?? result.lga ?? result.city ?? result.state ?? FALLBACK_AREA,
          lga: result.lga ?? null,
          state: result.state ?? null,
        };
      }
      this.logger.warn(`Reverse geocoding failed: ${result.error ?? 'unknown error'}`);
    } catch (error) {
      this.logger.warn(`Reverse geocoding threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { area: FALLBACK_AREA, lga: null, state: null };
  }

  toPublic(location: ErrandLocationRecord): PublicLocationView {
    return { area: location.area, lga: location.lga, state: location.state, approx: location.approx };
  }

  toParticipant(location: ErrandLocationRecord): ParticipantLocationView {
    return {
      ...this.toPublic(location),
      exact: location.exact,
      addressText: location.addressText,
      landmark: location.landmark,
    };
  }

  view(location: ErrandLocationRecord, level: LocationAccessLevel): PublicLocationView | ParticipantLocationView {
    return level === 'PARTICIPANT' ? this.toParticipant(location) : this.toPublic(location);
  }

  /** The bucketed distance label for a measured distance in metres. */
  bucket(meters: number): { upperKm: number; label: string } {
    return distanceBucket(meters);
  }
}

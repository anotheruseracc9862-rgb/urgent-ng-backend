import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BusinessConfigService } from '../config/business-config.service.js';
import { MAPS_PROVIDER, type IMapsProvider } from '../common/providers/maps.provider.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ERRAND_NOT_ELIGIBLE } from '../common/constants/error-codes.js';
import { resolveState } from './service-areas.js';

/** Uses alias e. Unknown states fail closed even when interstate expansion is enabled. */
export function errandGeographySql(interstateEnabled: boolean): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM errand_locations gl WHERE gl.errand_id = e.id AND gl.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM errand_locations gl WHERE gl.errand_id = e.id AND gl.deleted_at IS NULL AND gl.state_id IS NULL)
    AND (${interstateEnabled}::boolean OR
      (SELECT count(DISTINCT gl.state_id) FROM errand_locations gl WHERE gl.errand_id = e.id AND gl.deleted_at IS NULL) = 1)`;
}

/** Every stop must fit coverage, not just the pickup; aliases are internal constants only. */
export function runnerCoverageSql(alias: 'me' | 'rp', radiusKm?: number): Prisma.Sql {
  const profile = Prisma.raw(alias);
  return Prisma.sql`cardinality(${profile}.area_state_ids) > 0
    AND NOT EXISTS (
      SELECT 1 FROM errand_locations cl WHERE cl.errand_id = e.id AND cl.deleted_at IS NULL
        AND (cl.state_id IS NULL OR NOT (cl.state_id = ANY(${profile}.area_state_ids))
          OR (${profile}.area_mode = 'LGAS' AND (cl.lga_id IS NULL OR NOT (cl.lga_id = ANY(${profile}.area_lga_ids)))))
    )
    AND (${profile}.area_mode <> 'RADIUS' OR NOT EXISTS (
      SELECT 1 FROM errand_locations rl WHERE rl.errand_id = e.id AND rl.deleted_at IS NULL
        AND NOT ST_DWithin(rl.approx_point, ${profile}.area_center,
          LEAST(${profile}.area_radius_km::float8, ${radiusKm ?? 20}::float8) * 1000)))`;
}

@Injectable()
export class GeographyService {
  constructor(
    private readonly config: BusinessConfigService,
    @Inject(MAPS_PROVIDER) private readonly maps: IMapsProvider,
  ) {}

  async stateForPoint(point: { lat: number; lng: number }): Promise<string | undefined> {
    try {
      const place = await this.maps.reverseGeocode(point.lat, point.lng);
      return place.success ? resolveState(place.state)?.id : undefined;
    } catch {
      return undefined;
    }
  }

  async assertPublishable(locations: Array<{ stateId?: string | null }>): Promise<void> {
    if (locations.length === 0 || locations.some((location) => !location.stateId)) {
      throw DomainException.of(ERRAND_NOT_ELIGIBLE, {
        message: 'We could not verify the state for every location. Choose the locations again and save before publishing. Your draft is safe.',
        details: { reason: 'LOCATION_STATE_UNVERIFIED' },
      });
    }
    if (!(await this.config.get('INTERSTATE_ERRANDS_ENABLED')) && new Set(locations.map((location) => location.stateId)).size > 1) {
      throw DomainException.of(ERRAND_NOT_ELIGIBLE, {
        message: 'For now, pickup and destination must be in the same state.',
        details: { reason: 'INTERSTATE_NOT_AVAILABLE' },
      });
    }
  }
}

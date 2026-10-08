import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { RunnerAvailability, TransportMethod } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RATE_LIMITED, RESOURCE_CONFLICT, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';

const ABSOLUTE_MIN_KM = 1;
const ABSOLUTE_MAX_KM = 20;

export interface RunnerProfileView {
  transport: TransportMethod;
  areaCenter: { lat: number; lng: number };
  areaRadiusKm: number;
  availability: RunnerAvailability;
  excludedCategoryIds: string[];
}

export interface RunnerProfileInput {
  transport: TransportMethod;
  areaCenter: { lat: number; lng: number };
  areaRadiusKm?: number;
  excludedCategoryIds?: string[];
}

/**
 * The runner profile (Backend PRD 10.1): transport, one circular operating area, availability
 * and category exclusions. The area centre is a private location: it is only ever returned to its
 * owner. No vehicle, licence or ownership is asked for.
 */
@Injectable()
export class RunnerProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async get(userId: string): Promise<RunnerProfileView> {
    const rows = await this.prisma.$queryRaw<
      Array<{ transport: TransportMethod; lat: number; lng: number; radius: number; availability: RunnerAvailability; excluded: string[] }>
    >`
      SELECT transport::text AS transport,
             ST_Y(area_center::geometry) AS lat,
             ST_X(area_center::geometry) AS lng,
             area_radius_km::float8 AS radius,
             availability::text AS availability,
             excluded_category_ids::text[] AS excluded
      FROM runner_profiles
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
    `;
    if (rows.length === 0) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'You have not set up a runner profile yet.' });
    }
    const row = rows[0];
    return {
      transport: row.transport,
      areaCenter: { lat: row.lat, lng: row.lng },
      areaRadiusKm: row.radius,
      availability: row.availability,
      excludedCategoryIds: row.excluded,
    };
  }

  /** Create or replace the profile. Availability is never changed here (see `setAvailability`). */
  async upsert(userId: string, input: RunnerProfileInput): Promise<RunnerProfileView> {
    const [configMin, configMax, fallback] = await Promise.all([
      this.config.get('RUNNER_AREA_MIN_KM'),
      this.config.get('RUNNER_AREA_MAX_KM'),
      this.config.get('RUNNER_AREA_DEFAULT_KM'),
    ]);
    // The configured range may narrow 1 to 20 km but never widen it: the database enforces 1 to 20.
    const min = Math.max(configMin, ABSOLUTE_MIN_KM);
    const max = Math.min(configMax, ABSOLUTE_MAX_KM);
    const radius = input.areaRadiusKm ?? fallback;
    if (!(radius >= min && radius <= max)) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: `The operating area radius must be between ${min} and ${max} km.`,
        details: { field: 'areaRadiusKm', min, max },
      });
    }

    const excluded = [...new Set(input.excludedCategoryIds ?? [])];
    if (excluded.length > 0) {
      const found = await this.prisma.client.category.count({ where: { id: { in: excluded } } });
      if (found !== excluded.length) {
        throw DomainException.of(VALIDATION_ERROR, {
          message: 'One or more excluded categories do not exist.',
          details: { field: 'excludedCategoryIds' },
        });
      }
    }

    await this.limitAreaMoves(userId, input.areaCenter);

    await this.prisma.$executeRaw`
      INSERT INTO runner_profiles (user_id, transport, area_center, area_radius_km, excluded_category_ids, updated_at)
      VALUES (${userId}::uuid, ${input.transport}::"TransportMethod",
              ST_SetSRID(ST_MakePoint(${input.areaCenter.lng}::float8, ${input.areaCenter.lat}::float8), 4326)::geography,
              ${radius}::numeric, ${excluded}::uuid[], now())
      ON CONFLICT (user_id) DO UPDATE
        SET transport = EXCLUDED.transport,
            area_center = EXCLUDED.area_center,
            area_radius_km = EXCLUDED.area_radius_km,
            excluded_category_ids = EXCLUDED.excluded_category_ids,
            deleted_at = NULL,
            updated_at = now()
    `;
    return this.get(userId);
  }

  /**
   * Moving the operating-area centre is the only way to measure distances from a new place, so
   * it is limited like a position update (Backend PRD 17.2, `LOCATION_UPDATE_MIN_SECONDS`, default
   * 30 s): a runner who moves the centre again too soon gets RATE_LIMITED. Changing the radius,
   * the transport or the exclusions is not a move. Redis down: allowed.
   */
  private async limitAreaMoves(userId: string, center: { lat: number; lng: number }): Promise<void> {
    if (process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_DISABLED === 'true') {
      return;
    }
    const rows = await this.prisma.$queryRaw<Array<{ moved: boolean }>>`
      SELECT ST_Distance(area_center, ST_SetSRID(ST_MakePoint(${center.lng}::float8, ${center.lat}::float8), 4326)::geography) > 1 AS moved
      FROM runner_profiles WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
    `;
    if (!rows[0]?.moved) {
      return;
    }
    const seconds = await this.config.get('LOCATION_UPDATE_MIN_SECONDS');
    try {
      const key = `runner-area-move:${userId}`;
      if ((await this.redis.set(key, '1', 'EX', seconds, 'NX')) === null) {
        throw DomainException.of(RATE_LIMITED, {
          message: 'You moved your operating area a moment ago. Try again shortly.',
          details: { retryAfterSeconds: Math.max(1, await this.redis.ttl(key)) },
        });
      }
    } catch (error) {
      if (error instanceof DomainException) throw error;
    }
  }

  /** Unavailable runners do not see the feed and cannot submit new offers; existing offers are unaffected. */
  async setAvailability(userId: string, availability: RunnerAvailability): Promise<RunnerProfileView> {
    const updated = await this.prisma.$executeRaw`
      UPDATE runner_profiles SET availability = ${availability}::"RunnerAvailability", updated_at = now()
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
    `;
    if (updated === 0) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'Set up your runner profile first.' });
    }
    return this.get(userId);
  }
}

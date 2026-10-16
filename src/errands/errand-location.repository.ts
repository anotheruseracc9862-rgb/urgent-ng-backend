import { Injectable } from '@nestjs/common';
import type { LocationSource, LocationType, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import type { LatLng } from './location-privacy.js';
import { resolveState, resolveLga } from '../geography/service-areas.js';

export type ErrandLocationType = Extract<LocationType, 'ERRAND_PICKUP' | 'ERRAND_DESTINATION'>;

/** A stored location with both points read back as plain numbers. Never return this to a client. */
export interface ErrandLocationRecord {
  type: ErrandLocationType;
  exact: LatLng;
  approx: LatLng;
  addressText: string | null;
  landmark: string | null;
  area: string;
  lga: string | null;
  state: string | null;
  source: LocationSource;
  stateId?: string | null;
  lgaId?: string | null;
}

export interface ErrandLocationWrite {
  errandId: string;
  type: ErrandLocationType;
  exact: LatLng;
  approx: LatLng;
  addressText?: string | null;
  landmark?: string | null;
  area: string;
  lga?: string | null;
  state?: string | null;
  source: LocationSource;
}

type Client = Prisma.TransactionClient | PrismaService;

interface Row {
  errand_id: string;
  type: ErrandLocationType;
  exact_lat: number;
  exact_lng: number;
  approx_lat: number;
  approx_lng: number;
  address_text: string | null;
  landmark: string | null;
  area: string;
  lga: string | null;
  state: string | null;
  source: LocationSource;
  state_id: string | null;
  lga_id: string | null;
}

const toRecord = (row: Row): ErrandLocationRecord => ({
  type: row.type,
  exact: { lat: row.exact_lat, lng: row.exact_lng },
  approx: { lat: row.approx_lat, lng: row.approx_lng },
  addressText: row.address_text,
  landmark: row.landmark,
  area: row.area,
  lga: row.lga,
  state: row.state,
  stateId: row.state_id,
  lgaId: row.lga_id,
  source: row.source,
});

/**
 * The only code that reads or writes `errand_locations` (PostGIS needs raw SQL; Backend PRD 26.1).
 * Longitude goes first in `ST_MakePoint`.
 */
@Injectable()
export class ErrandLocationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(tx: Prisma.TransactionClient, input: ErrandLocationWrite): Promise<void> {
    const stateId = resolveState(input.state)?.id ?? null;
    const lgaId = stateId ? resolveLga(stateId, input.lga)?.id ?? null : null;
    await tx.$executeRaw`
      INSERT INTO errand_locations
        (errand_id, type, exact_point, approx_point, address_text, landmark, area, lga, state, state_id, lga_id, source, updated_at)
      VALUES (
        ${input.errandId}::uuid, ${input.type}::"LocationType",
        ST_SetSRID(ST_MakePoint(${input.exact.lng}::float8, ${input.exact.lat}::float8), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${input.approx.lng}::float8, ${input.approx.lat}::float8), 4326)::geography,
        ${input.addressText ?? null}, ${input.landmark ?? null}, ${input.area}, ${input.lga ?? null},
        ${input.state ?? null}, ${stateId}, ${lgaId}, ${input.source}::"LocationSource", now()
      )
      ON CONFLICT (errand_id, type) WHERE deleted_at IS NULL DO UPDATE SET
        exact_point = EXCLUDED.exact_point,
        approx_point = EXCLUDED.approx_point,
        address_text = EXCLUDED.address_text,
        landmark = EXCLUDED.landmark,
        area = EXCLUDED.area,
        lga = EXCLUDED.lga,
        state = EXCLUDED.state,
        state_id = EXCLUDED.state_id,
        lga_id = EXCLUDED.lga_id,
        source = EXCLUDED.source,
        updated_at = now()
    `;
  }

  /** Soft delete, like every business row. */
  async remove(tx: Prisma.TransactionClient, errandId: string, type: ErrandLocationType): Promise<void> {
    await tx.$executeRaw`
      UPDATE errand_locations SET deleted_at = now(), updated_at = now()
      WHERE errand_id = ${errandId}::uuid AND type = ${type}::"LocationType" AND deleted_at IS NULL
    `;
  }

  async findForErrand(client: Client, errandId: string): Promise<ErrandLocationRecord[]> {
    const rows = await client.$queryRaw<Row[]>`
      SELECT errand_id::text, type::text AS type,
             ST_Y(exact_point::geometry) AS exact_lat, ST_X(exact_point::geometry) AS exact_lng,
             ST_Y(approx_point::geometry) AS approx_lat, ST_X(approx_point::geometry) AS approx_lng,
             address_text, landmark, area, lga, state, state_id, lga_id, source::text AS source
      FROM errand_locations
      WHERE errand_id = ${errandId}::uuid AND deleted_at IS NULL
      ORDER BY type
    `;
    return rows.map(toRecord);
  }

  /** Locations of several errands, keyed by errand id. */
  async findForErrands(client: Client, errandIds: string[]): Promise<Map<string, ErrandLocationRecord[]>> {
    const byErrand = new Map<string, ErrandLocationRecord[]>();
    if (errandIds.length === 0) {
      return byErrand;
    }
    const rows = await client.$queryRaw<Row[]>`
      SELECT errand_id::text, type::text AS type,
             ST_Y(exact_point::geometry) AS exact_lat, ST_X(exact_point::geometry) AS exact_lng,
             ST_Y(approx_point::geometry) AS approx_lat, ST_X(approx_point::geometry) AS approx_lng,
             address_text, landmark, area, lga, state, state_id, lga_id, source::text AS source
      FROM errand_locations
      WHERE errand_id = ANY(${errandIds}::uuid[]) AND deleted_at IS NULL
      ORDER BY type
    `;
    for (const row of rows) {
      byErrand.set(row.errand_id, [...(byErrand.get(row.errand_id) ?? []), toRecord(row)]);
    }
    return byErrand;
  }

  /**
   * Point the feed index at the errand's primary location: the pickup, else the destination
   * (a shopping errand may have no pickup). Call it after every location change.
   */
  async refreshFeedPoint(tx: Prisma.TransactionClient, errandId: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE errands SET feed_point = (
        SELECT approx_point FROM errand_locations
        WHERE errand_id = ${errandId}::uuid AND deleted_at IS NULL
        ORDER BY CASE type WHEN 'ERRAND_PICKUP' THEN 0 ELSE 1 END
        LIMIT 1
      )
      WHERE id = ${errandId}::uuid
    `;
  }
}

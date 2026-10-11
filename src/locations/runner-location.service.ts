import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { MAPS_PROVIDER, type IMapsProvider } from '../common/providers/maps.provider.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  ASSIGNMENT_INVALID_STATE,
  LOCATION_NOT_AVAILABLE,
  LOCATION_PERMISSION_REQUIRED,
  RATE_LIMITED,
  RESOURCE_NOT_FOUND,
  VALIDATION_ERROR,
} from '../common/constants/error-codes.js';
import { freshnessOf, roundToGrid } from './live-location.js';
import type { LiveLocationDto, RecordedLocationDto, ReportLocationDto, SharingStateDto } from './runner-location.dto.js';

/** Errand statuses in which the runner's position is shared: accepted until delivered. */
const ACTIVE_ERRAND = ['ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED'];

interface AssignmentCtx {
  id: string;
  errand_id: string;
  requester_id: string;
  runner_id: string;
  status: string;
  errand_status: string;
  stopped_at: Date | null;
  db_now: Date;
}

interface LatestRow {
  lat: number;
  lng: number;
  captured_at: Date;
  received_at: Date;
  age_seconds: number;
}

/**
 * Runner location sharing and the live view (Backend PRD 17.3, 17.4, 17.6).
 *
 * - Optional: it needs the LOCATION_SHARING consent, and the runner can stop at any time.
 * - Rate limited: at most one stored update per `LOCATION_UPDATE_MIN_SECONDS`; an update from a
 *   runner who has not moved `LOCATION_MOVEMENT_THRESHOLD_METERS` is acknowledged but not stored,
 *   except as a heartbeat so the position does not go stale while they wait.
 * - Untrusted: `capturedAt` is clamped to now, and an implausible jump raises an anomaly event
 *   (a risk signal, never a block).
 * - Private: readers get a point rounded to about 250 m and a freshness label, never the exact
 *   position, and nothing at all once the position is older than `LOCATION_STALE_MINUTES`.
 */
@Injectable()
export class RunnerLocationService {
  private readonly logger = new Logger(RunnerLocationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: BusinessConfigService,
    @Inject(MAPS_PROVIDER) private readonly maps: IMapsProvider,
  ) {}

  // ---- Runner ----

  async record(userId: string, assignmentId: string, input: ReportLocationDto): Promise<RecordedLocationDto> {
    const [minSeconds, moveMeters, freshMinutes, maxSpeed] = await Promise.all([
      this.config.get('LOCATION_UPDATE_MIN_SECONDS'),
      this.config.get('LOCATION_MOVEMENT_THRESHOLD_METERS'),
      this.config.get('LOCATION_FRESH_MINUTES'),
      this.config.get('LOCATION_MAX_SPEED_MPS'),
    ]);
    const heartbeatSeconds = Math.max(minSeconds, Math.floor((freshMinutes * 60) / 2));

    return this.prisma.$transaction(async (tx) => {
      const ctx = await this.lockAssignment(tx, assignmentId, userId);
      if (ctx.runner_id !== userId) {
        // Only the runner reports; the requester of the same assignment gets "not found".
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }
      if (ctx.status !== 'ACCEPTED' || !ACTIVE_ERRAND.includes(ctx.errand_status)) {
        throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
          message: 'Location is shared only while the errand is active.',
          details: { status: ctx.status, errandStatus: ctx.errand_status },
        });
      }
      if (ctx.stopped_at) {
        throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
          message: 'You turned location sharing off for this errand.',
          details: { reason: 'SHARING_STOPPED' },
        });
      }
      const consent = await tx.consentRecord.findFirst({
        where: { userId, consentType: 'LOCATION_SHARING', withdrawnAt: null },
        select: { id: true },
      });
      if (!consent) {
        throw DomainException.of(LOCATION_PERMISSION_REQUIRED);
      }

      const last = await this.latest(tx, assignmentId);
      if (last && last.age_seconds_received < minSeconds) {
        throw DomainException.of(RATE_LIMITED, {
          message: 'Location updates are limited. Try again shortly.',
          details: { retryAfterSeconds: Math.max(1, Math.ceil(minSeconds - last.age_seconds_received)) },
        });
      }

      // Never trust the device clock past now, and refuse a position that is already old news.
      const device = input.capturedAt ? input.capturedAt.getTime() : ctx.db_now.getTime();
      const capturedAt = new Date(Math.min(device, ctx.db_now.getTime()));
      if (ctx.db_now.getTime() - capturedAt.getTime() > 10 * 60_000) {
        throw DomainException.of(VALIDATION_ERROR, { message: 'That position is too old to share.', details: { field: 'capturedAt' } });
      }

      let moved = Number.POSITIVE_INFINITY;
      if (last) {
        const rows = await tx.$queryRaw<Array<{ meters: number }>>`
          SELECT ST_Distance(
                   ST_SetSRID(ST_MakePoint(${last.lng}::float8, ${last.lat}::float8), 4326)::geography,
                   ST_SetSRID(ST_MakePoint(${input.lng}::float8, ${input.lat}::float8), 4326)::geography
                 )::float8 AS meters
        `;
        moved = rows[0].meters;
        if (moved < moveMeters && last.age_seconds_received < heartbeatSeconds) {
          return { recorded: false, result: 'NO_MOVEMENT' };
        }
        // Travel plausibility: a jump faster than any vehicle is a signal, not proof (Backend PRD 21.6).
        const seconds = Math.max(1, (capturedAt.getTime() - last.captured_at.getTime()) / 1000);
        if (moved > 1000 && moved / seconds > maxSpeed) {
          await this.outbox.add(tx, {
            eventType: 'runner_location.anomaly',
            aggregateType: 'assignment',
            aggregateId: assignmentId,
            payload: {
              assignmentId,
              errandId: ctx.errand_id,
              userId,
              signal: 'LOCATION_JUMP',
              meters: Math.round(moved),
              seconds: Math.round(seconds),
            },
          });
        }
      }

      await tx.$executeRaw`
        INSERT INTO location_records (assignment_id, user_id, point, accuracy_meters, captured_at)
        VALUES (
          ${assignmentId}::uuid, ${userId}::uuid,
          ST_SetSRID(ST_MakePoint(${input.lng}::float8, ${input.lat}::float8), 4326)::geography,
          ${input.accuracyMeters ?? null}::numeric, ${capturedAt}::timestamptz
        )
      `;
      return { recorded: true, result: 'STORED' };
    });
  }

  /** Stop or resume sharing for one errand (Backend PRD 17.3). Stopping keeps nothing new and shows nothing live. */
  async setSharing(userId: string, assignmentId: string, enabled: boolean): Promise<SharingStateDto> {
    await this.prisma.$transaction(async (tx) => {
      const ctx = await this.lockAssignment(tx, assignmentId, userId);
      if (ctx.runner_id !== userId) throw DomainException.of(RESOURCE_NOT_FOUND);
      await tx.$executeRaw`
        UPDATE assignments
        SET location_sharing_stopped_at = ${enabled ? null : ctx.db_now}::timestamptz, updated_at = clock_timestamp()
        WHERE id = ${assignmentId}::uuid
      `;
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: enabled ? 'location_sharing.resumed' : 'location_sharing.stopped',
        entityType: 'assignment',
        entityId: assignmentId,
      });
    });
    return { assignmentId, enabled };
  }

  // ---- Readers ----

  /** The live view for a party of the assignment. The requester sees the runner; the runner sees what they share. */
  async liveFor(userId: string, assignmentId: string): Promise<LiveLocationDto> {
    const ctx = await this.context(this.prisma, assignmentId);
    if (!ctx || (ctx.requester_id !== userId && ctx.runner_id !== userId)) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (ctx.status !== 'ACCEPTED' || !ACTIVE_ERRAND.includes(ctx.errand_status)) {
      throw DomainException.of(LOCATION_NOT_AVAILABLE);
    }
    return this.view(ctx);
  }

  /**
   * The same view without a viewer, for a caller that has already authorised the reader (a
   * trusted-contact link). Returns null when the errand has no live assignment.
   */
  async liveForAssignmentSystem(assignmentId: string): Promise<LiveLocationDto | null> {
    const ctx = await this.context(this.prisma, assignmentId);
    if (!ctx || ctx.status !== 'ACCEPTED' || !ACTIVE_ERRAND.includes(ctx.errand_status)) return null;
    return this.view(ctx);
  }

  /** Remove positions older than the retention period (Backend PRD 17.6). Returns how many. */
  async purgeExpired(batch = 1000): Promise<number> {
    const days = await this.config.get('LOCATION_HISTORY_RETENTION_DAYS');
    return this.prisma.$executeRaw`
      DELETE FROM location_records
      WHERE id IN (
        SELECT id FROM location_records
        WHERE captured_at < clock_timestamp() - make_interval(days => ${days}::int)
        LIMIT ${batch}
      )
    `;
  }

  // ---- Internals ----

  private async view(ctx: AssignmentCtx): Promise<LiveLocationDto> {
    const [freshMinutes, staleMinutes, roundMeters] = await Promise.all([
      this.config.get('LOCATION_FRESH_MINUTES'),
      this.config.get('LOCATION_STALE_MINUTES'),
      this.config.get('LOCATION_LIVE_ROUND_METERS'),
    ]);
    const last = await this.latest(this.prisma, ctx.id);
    const stopped = ctx.stopped_at !== null;
    const age = last ? last.age_seconds_captured : null;
    const freshness = freshnessOf(age, freshMinutes, staleMinutes);
    const visible = last !== null && !stopped && freshness !== 'EXPIRED' && freshness !== 'NONE';

    return {
      assignmentId: ctx.id,
      errandStatus: ctx.errand_status,
      sharing: stopped ? 'STOPPED' : 'ACTIVE',
      freshness: stopped ? 'NONE' : freshness,
      point: visible && last ? roundToGrid({ lat: last.lat, lng: last.lng }, roundMeters) : null,
      capturedAt: !stopped && last ? last.captured_at : null,
      ageSeconds: !stopped && age !== null ? Math.round(age) : null,
      estimatedArrivalMinutes: visible && freshness === 'FRESH' && last ? await this.eta(ctx, last) : null,
    };
  }

  /**
   * Minutes to the next stop, only from a traffic-aware estimate and a fresh position; otherwise
   * none (Backend PRD 17.4). The next stop is the pickup before pickup and the destination after.
   */
  private async eta(ctx: AssignmentCtx, from: LatestRow): Promise<number | null> {
    const type = ctx.errand_status === 'PICKED_UP' ? 'ERRAND_DESTINATION' : ctx.errand_status === 'DELIVERED' ? null : 'ERRAND_PICKUP';
    if (!type) return null;
    const rows = await this.prisma.$queryRaw<Array<{ lat: number; lng: number }>>`
      SELECT ST_Y(exact_point::geometry) AS lat, ST_X(exact_point::geometry) AS lng
      FROM errand_locations
      WHERE errand_id = ${ctx.errand_id}::uuid AND type = ${type}::"LocationType" AND deleted_at IS NULL
    `;
    const to = rows[0];
    if (!to) return null;
    try {
      const result = await this.maps.calculateDistance(from.lat, from.lng, to.lat, to.lng);
      if (!result.success || !result.trafficAware || result.durationSeconds === undefined) return null;
      return Math.max(1, Math.ceil(result.durationSeconds / 60));
    } catch (error) {
      this.logger.warn(`ETA unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async latest(
    client: Pick<PrismaService, '$queryRaw'>,
    assignmentId: string,
  ): Promise<(LatestRow & { age_seconds_received: number; age_seconds_captured: number }) | null> {
    const rows = await client.$queryRaw<Array<LatestRow & { age_seconds_received: number; age_seconds_captured: number }>>`
      SELECT ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng, captured_at, received_at,
             extract(epoch FROM (clock_timestamp() - received_at))::float8 AS age_seconds_received,
             extract(epoch FROM (clock_timestamp() - captured_at))::float8 AS age_seconds_captured
      FROM location_records
      WHERE assignment_id = ${assignmentId}::uuid
      ORDER BY captured_at DESC, received_at DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async lockAssignment(
    tx: Pick<PrismaService, '$queryRaw'>,
    assignmentId: string,
    userId: string,
  ): Promise<AssignmentCtx> {
    const rows = await tx.$queryRaw<AssignmentCtx[]>`
      SELECT a.id::text, a.errand_id::text, a.requester_id::text, a.runner_id::text, a.status::text AS status,
             e.status::text AS errand_status, a.location_sharing_stopped_at AS stopped_at, clock_timestamp() AS db_now
      FROM assignments a JOIN errands e ON e.id = a.errand_id
      WHERE a.id = ${assignmentId}::uuid AND a.deleted_at IS NULL
        AND (a.runner_id = ${userId}::uuid OR a.requester_id = ${userId}::uuid)
      FOR UPDATE OF a
    `;
    if (!rows[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
    return rows[0];
  }

  private async context(client: Pick<PrismaService, '$queryRaw'>, assignmentId: string): Promise<AssignmentCtx | null> {
    const rows = await client.$queryRaw<AssignmentCtx[]>`
      SELECT a.id::text, a.errand_id::text, a.requester_id::text, a.runner_id::text, a.status::text AS status,
             e.status::text AS errand_status, a.location_sharing_stopped_at AS stopped_at, clock_timestamp() AS db_now
      FROM assignments a JOIN errands e ON e.id = a.errand_id
      WHERE a.id = ${assignmentId}::uuid AND a.deleted_at IS NULL
    `;
    return rows[0] ?? null;
  }
}

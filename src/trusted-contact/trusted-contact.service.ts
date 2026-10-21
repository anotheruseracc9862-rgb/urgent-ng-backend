import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditActorType, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { hmacSign } from '../common/utils/crypto.helper.js';
import { MediaAccessService } from '../media/media-access.service.js';
import { UserStatsService } from '../ratings/user-stats.service.js';
import { VerificationStatusService } from '../verification/verification-status.service.js';
import { RunnerLocationService } from '../locations/runner-location.service.js';
import { roundToGrid } from '../locations/live-location.js';
import { ReportService } from '../reports/report.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ERRAND_INVALID_STATE, RATE_LIMITED, RESOURCE_CONFLICT, RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import type { CreatedShareDto, SharedAreaDto, SharedErrandDto, ShareDto } from './trusted-contact.dto.js';

/** Errand statuses in which a link can be made: accepted until delivered. */
const ACTIVE_ERRAND = ['ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED'];
const PHOTO_SECONDS = 300;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface ShareRow {
  id: string;
  errand_id: string;
  created_by: string;
  status: string;
  expires_at: Date;
  effective_expires_at: Date;
  view_count: number;
  last_viewed_at: Date | null;
  concern_raised_at: Date | null;
  created_at: Date;
  db_now: Date;
}

/**
 * Trusted-contact links (Backend PRD 17.5): a read-only view of an active errand for someone the
 * requester or the runner trusts, with no account.
 *
 * - The token is 32 random bytes, shown once; only a keyed hash is stored. It is time-limited
 *   (`TRUSTED_LINK_MAX_HOURS` from creation, and `TRUSTED_LINK_POST_TERMINAL_HOURS` after the
 *   errand ends, whichever is first) and revocable.
 * - A link that is unknown, expired or revoked answers "not found" the same way, so a probe learns
 *   nothing.
 * - The response is built from a fixed list of fields. An exact address, phone number, chat, exact
 *   GPS history, payment or verification detail is never read into it.
 */
@Injectable()
export class TrustedContactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: BusinessConfigService,
    private readonly appConfig: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly mediaAccess: MediaAccessService,
    private readonly stats: UserStatsService,
    private readonly verification: VerificationStatusService,
    private readonly locations: RunnerLocationService,
    private readonly reports: ReportService,
  ) {}

  // ---- The account holder ----

  async create(userId: string, errandId: string): Promise<CreatedShareDto> {
    const [maxActive, maxHours] = await Promise.all([
      this.config.get('TRUSTED_LINK_MAX_ACTIVE_PER_ERRAND'),
      this.config.get('TRUSTED_LINK_MAX_HOURS'),
    ]);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.hash(token);

    const created = await this.prisma.$transaction(async (tx) => {
      const errand = await this.partyErrand(tx, userId, errandId, true);
      if (!ACTIVE_ERRAND.includes(errand.status)) {
        throw DomainException.of(ERRAND_INVALID_STATE, {
          message: 'A link can be made while the errand is active.',
          details: { status: errand.status },
        });
      }
      const active = await this.activeCount(tx, errandId);
      if (active >= maxActive) {
        throw DomainException.of(RESOURCE_CONFLICT, {
          message: `An errand can have ${maxActive} active links. Revoke one first.`,
          details: { reason: 'LINK_LIMIT', limit: maxActive },
        });
      }
      const rows = await tx.$queryRaw<Array<{ id: string; expires_at: Date }>>`
        INSERT INTO trusted_contact_shares (errand_id, created_by, token_hash, status, expires_at)
        VALUES (${errandId}::uuid, ${userId}::uuid, ${tokenHash}, 'ACTIVE'::"TrustedShareStatus",
                clock_timestamp() + make_interval(hours => ${maxHours}::int))
        RETURNING id::text, expires_at
      `;
      const share = rows[0];
      await this.outbox.add(tx, {
        eventType: 'trusted_contact.created',
        aggregateType: 'errand',
        aggregateId: errandId,
        payload: { shareId: share.id, errandId, createdBy: userId },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'trusted_contact.created',
        entityType: 'errand',
        entityId: errandId,
        metadata: { shareId: share.id },
      });
      return share;
    });
    return { id: created.id, token, path: `/shared/${token}`, expiresAt: created.expires_at };
  }

  /** Links on an errand: the requester sees every one, the runner their own. */
  async list(userId: string, errandId: string): Promise<ShareDto[]> {
    const errand = await this.partyErrand(this.prisma, userId, errandId, false);
    const hours = await this.config.get('TRUSTED_LINK_POST_TERMINAL_HOURS');
    const rows = await this.prisma.$queryRaw<ShareRow[]>`
      SELECT ${this.shareColumns(hours)}
      FROM trusted_contact_shares s JOIN errands e ON e.id = s.errand_id
      WHERE s.errand_id = ${errandId}::uuid AND s.deleted_at IS NULL
        AND (${errand.isRequester}::boolean OR s.created_by = ${userId}::uuid)
      ORDER BY s.created_at DESC
    `;
    return rows.map((row) => this.toShareDto(row, userId));
  }

  /** The creator, or the requester of the errand, can end a link. Idempotent for a link already ended. */
  async revoke(userId: string, shareId: string): Promise<ShareDto> {
    const hours = await this.config.get('TRUSTED_LINK_POST_TERMINAL_HOURS');
    const row = await this.prisma.$transaction(async (tx) => {
      const found = await tx.$queryRaw<Array<{ id: string; errand_id: string; created_by: string; requester_id: string }>>`
        SELECT s.id::text, s.errand_id::text, s.created_by::text, e.requester_id::text
        FROM trusted_contact_shares s JOIN errands e ON e.id = s.errand_id
        WHERE s.id = ${shareId}::uuid AND s.deleted_at IS NULL
        FOR UPDATE OF s
      `;
      const share = found[0];
      if (!share || (share.created_by !== userId && share.requester_id !== userId)) {
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }
      const changed = await tx.$executeRaw`
        UPDATE trusted_contact_shares
        SET status = 'REVOKED'::"TrustedShareStatus", revoked_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${shareId}::uuid AND status IN ('CREATED'::"TrustedShareStatus", 'ACTIVE'::"TrustedShareStatus")
      `;
      if (changed > 0) {
        await this.outbox.add(tx, {
          eventType: 'trusted_contact.revoked',
          aggregateType: 'errand',
          aggregateId: share.errand_id,
          payload: { shareId, errandId: share.errand_id, revokedBy: userId },
        });
        await this.audit.recordInTransaction(tx, {
          actorType: AuditActorType.USER,
          actorId: userId,
          action: 'trusted_contact.revoked',
          entityType: 'errand',
          entityId: share.errand_id,
          metadata: { shareId },
        });
      }
      const rows = await tx.$queryRaw<ShareRow[]>`
        SELECT ${this.shareColumns(hours)}
        FROM trusted_contact_shares s JOIN errands e ON e.id = s.errand_id WHERE s.id = ${shareId}::uuid
      `;
      return rows[0];
    });
    return this.toShareDto(row, userId);
  }

  // ---- The trusted contact (no account) ----

  async publicView(token: string): Promise<SharedErrandDto> {
    const share = await this.resolve(token);
    await this.limitViews(share.id);
    await this.prisma.$executeRaw`
      UPDATE trusted_contact_shares
      SET view_count = view_count + 1, last_viewed_at = clock_timestamp()
      WHERE id = ${share.id}::uuid
    `;
    return this.build(share);
  }

  /** The trusted contact flags a safety concern. It becomes a report from the link's creator and notifies them. */
  async raiseConcern(token: string, message: string | undefined): Promise<{ received: boolean }> {
    const share = await this.resolve(token);
    const cooldown = await this.config.get('TRUSTED_LINK_CONCERN_COOLDOWN_MINUTES');
    if (!(process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_DISABLED === 'true')) {
      try {
        if ((await this.redis.set(`trusted-concern:${share.id}`, '1', 'EX', cooldown * 60, 'NX')) === null) {
          throw DomainException.of(RATE_LIMITED, { message: 'A concern was just sent from this link.' });
        }
      } catch (error) {
        if (error instanceof DomainException) throw error;
      }
    }

    const parties = await this.prisma.$queryRaw<Array<{ assignment_id: string; requester_id: string; runner_id: string }>>`
      SELECT a.id::text AS assignment_id, a.requester_id::text, a.runner_id::text
      FROM assignments a
      WHERE a.errand_id = ${share.errand_id}::uuid AND a.deleted_at IS NULL
        AND a.status IN ('ACCEPTED'::"AssignmentStatus", 'COMPLETED'::"AssignmentStatus", 'CANCELLED'::"AssignmentStatus")
      ORDER BY a.created_at DESC LIMIT 1
    `;
    const assignment = parties[0];
    if (!assignment) throw DomainException.of(RESOURCE_NOT_FOUND);
    // The report is from the link's creator, about the other party of the errand.
    const other = assignment.requester_id === share.created_by ? assignment.runner_id : assignment.requester_id;
    const text = message?.trim();
    await this.reports.create(share.created_by, {
      targetType: 'USER',
      targetId: other,
      type: 'UNSAFE_BEHAVIOR',
      assignmentId: assignment.assignment_id,
      description: `Safety concern raised by a trusted contact through a shared link.${text ? ` They wrote: ${text}` : ''}`,
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE trusted_contact_shares SET concern_raised_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${share.id}::uuid
      `;
      await this.outbox.add(tx, {
        eventType: 'trusted_contact.concern',
        aggregateType: 'errand',
        aggregateId: share.errand_id,
        payload: { shareId: share.id, errandId: share.errand_id, createdBy: share.created_by, at: new Date().toISOString() },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.SYSTEM,
        action: 'trusted_contact.concern_raised',
        entityType: 'errand',
        entityId: share.errand_id,
        metadata: { shareId: share.id },
      });
    });
    return { received: true };
  }

  // ---- Scheduler ----

  /** Move links past their effective expiry to EXPIRED (they already stop answering on read). */
  async expireDue(): Promise<number> {
    const hours = await this.config.get('TRUSTED_LINK_POST_TERMINAL_HOURS');
    return this.prisma.$executeRaw`
      UPDATE trusted_contact_shares s
      SET status = 'EXPIRED'::"TrustedShareStatus", updated_at = clock_timestamp()
      FROM errands e
      WHERE e.id = s.errand_id AND s.deleted_at IS NULL
        AND s.status IN ('CREATED'::"TrustedShareStatus", 'ACTIVE'::"TrustedShareStatus")
        AND LEAST(s.expires_at, COALESCE(GREATEST(e.completed_at, e.cancelled_at), 'infinity'::timestamptz) + make_interval(hours => ${hours}::int))
            <= clock_timestamp()
    `;
  }

  // ---- Internals ----

  private async build(share: ShareRow): Promise<SharedErrandDto> {
    const gridMeters = await this.config.get('TRUSTED_LINK_AREA_GRID_METERS');
    const rows = await this.prisma.$queryRaw<
      Array<{
        title: string;
        status: string;
        category_name: string;
        category_flow: 'TRANSIT' | 'SERVICE';
        requester_first_name: string;
        updated_at: Date;
        assignment_id: string | null;
        runner_id: string | null;
        runner_first_name: string | null;
        runner_last_name: string | null;
        photo_media_id: string | null;
        accepted_at: Date | null;
        duration_minutes: number | null;
      }>
    >`
      SELECT e.title, e.status::text AS status, c.name AS category_name, c.flow::text AS category_flow, ru.first_name AS requester_first_name, e.updated_at,
             a.id::text AS assignment_id, a.runner_id::text, rn.first_name AS runner_first_name, rn.last_name AS runner_last_name,
             pr.photo_media_id::text AS photo_media_id, a.accepted_at, o.duration_minutes
      FROM errands e
      JOIN categories c ON c.id = e.category_id
      JOIN users ru ON ru.id = e.requester_id
      LEFT JOIN LATERAL (
        SELECT * FROM assignments x
        WHERE x.errand_id = e.id AND x.deleted_at IS NULL
          AND x.status IN ('ACCEPTED'::"AssignmentStatus", 'COMPLETED'::"AssignmentStatus", 'CANCELLED'::"AssignmentStatus")
        ORDER BY x.created_at DESC LIMIT 1
      ) a ON TRUE
      LEFT JOIN users rn ON rn.id = a.runner_id
      LEFT JOIN profiles pr ON pr.user_id = a.runner_id AND pr.deleted_at IS NULL
      LEFT JOIN offers o ON o.id = a.selected_offer_id
      WHERE e.id = ${share.errand_id}::uuid AND e.deleted_at IS NULL
    `;
    const row = rows[0];
    if (!row || !row.runner_id || !row.assignment_id) throw DomainException.of(RESOURCE_NOT_FOUND);

    const [areas, events, delay, live, verified, stats, photo] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{ type: string; area: string; lga: string | null; state: string | null; lat: number; lng: number }>
      >`
        SELECT type::text AS type, area, lga, state, ST_Y(approx_point::geometry) AS lat, ST_X(approx_point::geometry) AS lng
        FROM errand_locations WHERE errand_id = ${share.errand_id}::uuid AND deleted_at IS NULL
      `,
      this.prisma.$queryRaw<Array<{ type: string; created_at: Date }>>`
        SELECT type::text AS type, created_at FROM execution_events
        WHERE assignment_id = ${row.assignment_id}::uuid AND type IN ('PICKED_UP'::"ExecutionEventType", 'DELIVERED'::"ExecutionEventType")
        ORDER BY created_at
      `,
      this.prisma.$queryRaw<Array<{ created_at: Date; minutes: number | null }>>`
        SELECT created_at, (metadata->>'newEstimateMinutes')::int AS minutes FROM execution_events
        WHERE assignment_id = ${row.assignment_id}::uuid AND type = 'DELAY_NOTICE'::"ExecutionEventType"
        ORDER BY created_at DESC LIMIT 1
      `,
      this.locations.liveForAssignmentSystem(row.assignment_id),
      this.verification.isVerified(row.runner_id),
      this.stats.get(row.runner_id),
      row.photo_media_id ? this.mediaAccess.urlForSharedProfilePhoto(row.photo_media_id, PHOTO_SECONDS) : Promise.resolve(null),
    ]);

    const area = (type: string): SharedAreaDto | null => {
      const found = areas.find((a) => a.type === type);
      if (!found) return null;
      const snapped = roundToGrid({ lat: found.lat, lng: found.lng }, gridMeters);
      return { area: found.area, lga: found.lga, state: found.state, lat: snapped.lat, lng: snapped.lng };
    };

    const delayEnd = delay[0]?.minutes != null ? new Date(delay[0].created_at.getTime() + delay[0].minutes * 60_000) : null;
    const planned = row.accepted_at && row.duration_minutes ? new Date(row.accepted_at.getTime() + row.duration_minutes * 60_000) : null;
    const checkpoints = events.map((e) => ({ type: e.type, at: e.created_at }));
    const times = [row.updated_at, ...events.map((e) => e.created_at), ...(delay[0] ? [delay[0].created_at] : []), ...(live?.capturedAt ? [live.capturedAt] : [])];

    return {
      title: row.title,
      category: row.category_name,
      categoryFlow: row.category_flow,
      requesterFirstName: row.requester_first_name,
      runner: {
        firstName: row.runner_first_name ?? '',
        lastInitial: (row.runner_last_name ?? '').charAt(0).toUpperCase(),
        photoUrl: photo?.url ?? null,
        verified,
        ratingAverage: stats.runner.average,
        ratingCount: stats.runner.count,
      },
      status: row.status,
      checkpoints,
      pickup: area('ERRAND_PICKUP'),
      destination: area('ERRAND_DESTINATION'),
      live: live
        ? { freshness: live.freshness, lat: live.point?.lat ?? null, lng: live.point?.lng ?? null, capturedAt: live.capturedAt }
        : null,
      lastUpdatedAt: new Date(Math.max(...times.map((t) => t.getTime()))),
      expectedDeliveryAt: delayEnd ?? planned,
      linkExpiresAt: share.effective_expires_at,
    };
  }

  /** A live link by its token, or "not found" for an unknown, revoked or expired one. */
  private async resolve(token: string): Promise<ShareRow> {
    if (!TOKEN_PATTERN.test(token)) throw DomainException.of(RESOURCE_NOT_FOUND);
    const hours = await this.config.get('TRUSTED_LINK_POST_TERMINAL_HOURS');
    const rows = await this.prisma.$queryRaw<ShareRow[]>`
      SELECT ${this.shareColumns(hours)}
      FROM trusted_contact_shares s JOIN errands e ON e.id = s.errand_id
      WHERE s.token_hash = ${this.hash(token)} AND s.deleted_at IS NULL
    `;
    const row = rows[0];
    if (!row || !['CREATED', 'ACTIVE'].includes(row.status) || row.effective_expires_at.getTime() <= row.db_now.getTime()) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return row;
  }

  /** 30 views a minute per link, on top of the per-address limit on the route. Redis down: allowed. */
  private async limitViews(shareId: string): Promise<void> {
    if (process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_DISABLED === 'true') return;
    try {
      const key = `trusted-view:${shareId}`;
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, 60);
      if (count > 30) {
        throw DomainException.of(RATE_LIMITED, { message: 'This link is being opened too often. Try again in a minute.' });
      }
    } catch (error) {
      if (error instanceof DomainException) throw error;
    }
  }

  private shareColumns(postTerminalHours: number): Prisma.Sql {
    return Prisma.sql`
      s.id::text, s.errand_id::text, s.created_by::text, s.status::text AS status, s.expires_at,
      LEAST(s.expires_at, COALESCE(GREATEST(e.completed_at, e.cancelled_at), 'infinity'::timestamptz)
            + make_interval(hours => ${postTerminalHours}::int)) AS effective_expires_at,
      s.view_count, s.last_viewed_at, s.concern_raised_at, s.created_at, clock_timestamp() AS db_now`;
  }

  private toShareDto(row: ShareRow, viewerId: string): ShareDto {
    const ended = ['REVOKED', 'EXPIRED'].includes(row.status);
    const lapsed = !ended && row.effective_expires_at.getTime() <= row.db_now.getTime();
    return {
      id: row.id,
      errandId: row.errand_id,
      status: lapsed ? 'EXPIRED' : row.status,
      createdByMe: row.created_by === viewerId,
      expiresAt: row.effective_expires_at,
      viewCount: row.view_count,
      lastViewedAt: row.last_viewed_at,
      concernRaisedAt: row.concern_raised_at,
      createdAt: row.created_at,
    };
  }

  private async activeCount(tx: Prisma.TransactionClient, errandId: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM trusted_contact_shares
      WHERE errand_id = ${errandId}::uuid AND deleted_at IS NULL
        AND status IN ('CREATED'::"TrustedShareStatus", 'ACTIVE'::"TrustedShareStatus") AND expires_at > clock_timestamp()
    `;
    return rows[0].n;
  }

  /** The errand, for its requester or the runner of its live assignment. Anyone else gets "not found". */
  private async partyErrand(
    client: Pick<PrismaService, '$queryRaw'>,
    userId: string,
    errandId: string,
    lock: boolean,
  ): Promise<{ status: string; isRequester: boolean }> {
    const rows = lock
      ? await client.$queryRaw<Array<{ status: string; requester_id: string; runner_id: string | null }>>`
          SELECT e.status::text AS status, e.requester_id::text,
                 (SELECT a.runner_id::text FROM assignments a WHERE a.errand_id = e.id AND a.deleted_at IS NULL
                    AND a.status = 'ACCEPTED'::"AssignmentStatus" LIMIT 1) AS runner_id
          FROM errands e WHERE e.id = ${errandId}::uuid AND e.deleted_at IS NULL
          FOR UPDATE OF e
        `
      : await client.$queryRaw<Array<{ status: string; requester_id: string; runner_id: string | null }>>`
          SELECT e.status::text AS status, e.requester_id::text,
                 (SELECT a.runner_id::text FROM assignments a WHERE a.errand_id = e.id AND a.deleted_at IS NULL
                    AND a.status IN ('ACCEPTED'::"AssignmentStatus", 'COMPLETED'::"AssignmentStatus") ORDER BY a.created_at DESC LIMIT 1) AS runner_id
          FROM errands e WHERE e.id = ${errandId}::uuid AND e.deleted_at IS NULL
        `;
    const row = rows[0];
    if (!row || (row.requester_id !== userId && row.runner_id !== userId)) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return { status: row.status, isRequester: row.requester_id === userId };
  }

  private hash(token: string): string {
    return hmacSign(`trusted-link:${token}`, this.appConfig.getOrThrow<string>('security.hmacSecret'));
  }
}

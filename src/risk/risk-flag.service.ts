import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AuditActorType, type Prisma, type RiskFlag } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ERRAND_INVALID_STATE, RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { BusinessConfigService } from '../config/business-config.service.js';

export const RISK_SIGNALS = [
  'OTP_ABUSE',
  'OFFER_SPAM',
  'FEED_PROBING',
  'RATING_ANOMALY',
  'SELF_DEALING',
  'LOCATION_ANOMALY',
] as const;

export type RiskSignal = (typeof RISK_SIGNALS)[number];

export interface RaiseRiskFlagInput {
  signal: RiskSignal;
  userId?: string | null;
  errandId?: string | null;
  /** For a signal with no account: a keyed digest of the subject, never the value (a phone, an email). */
  subjectKey?: string | null;
  /** Figures that explain the signal. No addresses, phone numbers, emails, message text or coordinates. */
  details?: Record<string, unknown>;
}

export interface RiskFlagFilter {
  status?: 'OPEN' | 'REVIEWED' | 'DISMISSED' | 'ACTIONED';
  signal?: RiskSignal;
  userId?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Risk signals (Backend PRD 21.6). A flag records that something looked unusual and puts it in
 * front of an admin. It never blocks anyone by itself: whatever follows is a human decision made
 * through enforcement. The same signal raised again while a flag is open raises its count instead
 * of adding a row, so a noisy signal is one line in the review queue.
 */
@Injectable()
export class RiskFlagService {
  private readonly logger = new Logger(RiskFlagService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cursors: CursorService,
    private readonly config: BusinessConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Raise (or re-raise) a flag. Returns whether a new flag was opened. */
  async raise(client: Pick<Prisma.TransactionClient, '$queryRaw'>, input: RaiseRiskFlagInput): Promise<boolean> {
    const rows = await client.$queryRaw<Array<{ inserted: boolean }>>`
      INSERT INTO risk_flags (user_id, errand_id, signal, subject_key, details)
      VALUES (${input.userId ?? null}::uuid, ${input.errandId ?? null}::uuid, ${input.signal}, ${input.subjectKey ?? null},
              ${input.details ? JSON.stringify(input.details) : null}::jsonb)
      ON CONFLICT (
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(errand_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(subject_key, ''),
        signal
      ) WHERE status = 'OPEN' AND deleted_at IS NULL
      DO UPDATE SET occurrences = risk_flags.occurrences + 1, last_seen_at = clock_timestamp(),
                    details = COALESCE(EXCLUDED.details, risk_flags.details)
      RETURNING (xmax = 0) AS inserted
    `;
    return rows[0]?.inserted === true;
  }

  /**
   * Raise from a code path that must not fail because the signal could not be written (a login,
   * a feed request). A failure is logged and swallowed: a missing flag is better than a blocked user.
   */
  async raiseQuietly(input: RaiseRiskFlagInput): Promise<void> {
    try {
      await this.raise(this.prisma, input);
    } catch (error) {
      this.logger.warn(`Could not raise ${input.signal}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Note that `userId` looked at `errandId` from the operating-area centre `centreKey`. Viewing
   * one errand from many different centres is how its position would be triangulated (Backend PRD
   * 17.2), so a runner who does it `RISK_PROBE_DISTINCT_POSITIONS` times within the window raises a
   * FEED_PROBING flag. Never blocks and never throws; Redis down means no signal.
   */
  async watchProbing(userId: string, errandId: string, centreKey: string | null): Promise<void> {
    if (!centreKey) return;
    try {
      const [distinct, minutes] = await Promise.all([
        this.config.get('RISK_PROBE_DISTINCT_POSITIONS'),
        this.config.get('RISK_PROBE_WINDOW_MINUTES'),
      ]);
      const key = `risk:probe:${userId}:${errandId}`;
      await this.redis.sadd(key, centreKey);
      await this.redis.expire(key, minutes * 60);
      const seen = await this.redis.scard(key);
      if (seen >= distinct) {
        await this.raiseQuietly({
          signal: 'FEED_PROBING',
          userId,
          errandId,
          details: { distinctPositions: seen, windowMinutes: minutes },
        });
      }
    } catch (error) {
      this.logger.warn(`Probe watch skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- Review queue (controllers arrive with P11) ----

  async list(filter: RiskFlagFilter = {}): Promise<Paginated<RiskFlag>> {
    const limit = filter.limit ?? 50;
    const cursor = filter.cursor ? this.cursors.decode(filter.cursor) : undefined;
    const rows = await this.prisma.riskFlag.findMany({
      where: {
        deletedAt: null,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.signal ? { signal: filter.signal } : {}),
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt as Date } }, { createdAt: cursor.createdAt as Date, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return new Paginated(page, {
      hasNextPage,
      ...(hasNextPage && last
        ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) }
        : {}),
    });
  }

  /** An admin looked at a flag: REVIEWED (seen, nothing to do), DISMISSED (a false alarm) or ACTIONED (acted on elsewhere). */
  async review(
    flagId: string,
    status: 'REVIEWED' | 'DISMISSED' | 'ACTIONED',
    note: string,
    admin: { adminId: string },
  ): Promise<RiskFlag> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM risk_flags
        WHERE id = ${flagId}::uuid AND deleted_at IS NULL AND status = 'OPEN'::"RiskFlagStatus" FOR UPDATE
      `;
      if (!locked[0]) {
        const exists = await tx.riskFlag.findFirst({ where: { id: flagId, deletedAt: null }, select: { id: true } });
        throw exists
          ? DomainException.of(ERRAND_INVALID_STATE, { message: 'This flag was already reviewed.', details: { reason: 'FLAG_CLOSED' } })
          : DomainException.of(RESOURCE_NOT_FOUND);
      }
      const updated = await tx.riskFlag.update({
        where: { id: flagId },
        data: { status, reviewedBy: admin.adminId, reviewedAt: new Date(), reviewNote: note.trim() || null },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: admin.adminId,
        action: 'risk_flag.reviewed',
        entityType: 'risk_flag',
        entityId: flagId,
        reasonCode: status,
        metadata: { signal: updated.signal, userId: updated.userId },
      });
      return updated;
    });
  }
}

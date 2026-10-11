import { Injectable } from '@nestjs/common';
import { AuditActorType, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { BOOST_NOT_ELIGIBLE, RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import { boostWindow } from '../billing/billing.rules.js';

export interface BoostActivation {
  boostId: string;
  /** false when the errand was no longer open at payment time: the boost is cancelled and the order must be refunded. */
  activated: boolean;
  expiresAt: Date | null;
  reason?: string;
}

/**
 * Priority boosts (Backend PRD 22.5): a paid, time-limited lift for one OPEN errand.
 *
 * - One live boost per errand (partial unique index), so a second purchase is `BOOST_NOT_ELIGIBLE`.
 * - It lasts `PRIORITY_BOOST_MAX_HOURS`, never past the errand's own deadline, and ends when a
 *   runner is selected or the errand leaves OPEN.
 * - A boost never overrides eligibility, location privacy or moderation: it only pins the errand
 *   higher in a feed that still applies every filter.
 */
@Injectable()
export class BoostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: BusinessConfigService,
  ) {}

  /** Can this user buy a boost for this errand now? Anyone but the owner gets "not found". */
  async assertEligible(userId: string, errandId: string): Promise<void> {
    const errand = await this.prisma.$queryRaw<Array<{ status: string; requester_id: string; expired: boolean }>>`
      SELECT status::text AS status, requester_id::text, (expires_at IS NOT NULL AND expires_at <= clock_timestamp()) AS expired
      FROM errands WHERE id = ${errandId}::uuid AND deleted_at IS NULL
    `;
    const row = errand[0];
    if (!row || row.requester_id !== userId) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (row.status !== 'OPEN' || row.expired) {
      throw DomainException.of(BOOST_NOT_ELIGIBLE, {
        message: 'Only an open errand can be boosted.',
        details: { reason: 'NOT_OPEN', status: row.status },
      });
    }
    const live = await this.prisma.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one FROM boosts
      WHERE errand_id = ${errandId}::uuid AND status IN ('PURCHASED'::"BoostStatus", 'SCHEDULED'::"BoostStatus", 'ACTIVE'::"BoostStatus")
      LIMIT 1
    `;
    if (live.length > 0) {
      throw DomainException.of(BOOST_NOT_ELIGIBLE, {
        message: 'This errand already has a boost.',
        details: { reason: 'ALREADY_BOOSTED' },
      });
    }
  }

  /**
   * Activate the boost a paid order bought, inside the settlement transaction. If the errand left
   * OPEN between the purchase and the payment, nothing is activated: the boost row is CANCELLED
   * and the caller refunds the order (Backend PRD 22.5).
   */
  async activate(
    tx: Prisma.TransactionClient,
    input: { orderId: string; errandId: string; userId: string; maxHours: number },
  ): Promise<BoostActivation> {
    const errand = await tx.$queryRaw<Array<{ status: string; expires_at: Date | null; db_now: Date }>>`
      SELECT status::text AS status, expires_at, clock_timestamp() AS db_now
      FROM errands WHERE id = ${input.errandId}::uuid AND deleted_at IS NULL FOR SHARE
    `;
    const row = errand[0];
    const window = row && row.status === 'OPEN' ? boostWindow({ now: row.db_now, maxHours: input.maxHours, errandExpiresAt: row.expires_at }) : null;

    if (!row || !window) {
      const created = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO boosts (errand_id, order_id, status, ended_reason, updated_at)
        VALUES (${input.errandId}::uuid, ${input.orderId}::uuid, 'CANCELLED'::"BoostStatus", 'ERRAND_NOT_OPEN', clock_timestamp())
        ON CONFLICT (order_id) DO UPDATE SET updated_at = clock_timestamp()
        RETURNING id::text
      `;
      return { boostId: created[0].id, activated: false, expiresAt: null, reason: 'ERRAND_NOT_OPEN' };
    }

    const created = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO boosts (errand_id, order_id, status, activates_at, expires_at, updated_at)
      VALUES (${input.errandId}::uuid, ${input.orderId}::uuid, 'ACTIVE'::"BoostStatus",
              ${window.activatesAt}::timestamptz, ${window.expiresAt}::timestamptz, clock_timestamp())
      ON CONFLICT (order_id) DO UPDATE SET updated_at = clock_timestamp()
      RETURNING id::text
    `;
    const boostId = created[0].id;
    await this.outbox.add(tx, {
      eventType: 'boost.activated',
      aggregateType: 'errand',
      aggregateId: input.errandId,
      payload: { boostId, errandId: input.errandId, userId: input.userId, orderId: input.orderId, expiresAt: window.expiresAt },
    });
    await this.audit.recordInTransaction(tx, {
      actorType: AuditActorType.SYSTEM,
      action: 'boost.activated',
      entityType: 'boost',
      entityId: boostId,
      metadata: { errandId: input.errandId, orderId: input.orderId, expiresAt: window.expiresAt },
    });
    return { boostId, activated: true, expiresAt: window.expiresAt };
  }

  /** End a live boost because the errand is no longer open to runners (selected, cancelled, expired). */
  async endForErrand(tx: Prisma.TransactionClient, errandId: string, reason: string): Promise<number> {
    const ended = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE boosts
      SET status = 'EXPIRED'::"BoostStatus", ended_reason = ${reason}, updated_at = clock_timestamp()
      WHERE errand_id = ${errandId}::uuid AND status IN ('ACTIVE'::"BoostStatus", 'SCHEDULED'::"BoostStatus", 'PURCHASED'::"BoostStatus")
      RETURNING id::text
    `;
    for (const { id } of ended) {
      await this.outbox.add(tx, {
        eventType: 'boost.expired',
        aggregateType: 'errand',
        aggregateId: errandId,
        payload: { boostId: id, errandId, reason },
      });
    }
    return ended.length;
  }

  /** End boosts whose time ran out. The feed also ignores an overdue boost on read, so a late sweep is harmless. */
  async expireDue(batch = 200): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<Array<{ id: string; errand_id: string }>>`
        UPDATE boosts
        SET status = 'EXPIRED'::"BoostStatus", ended_reason = 'TIME_ELAPSED', updated_at = clock_timestamp()
        WHERE id IN (
          SELECT id FROM boosts
          WHERE status = 'ACTIVE'::"BoostStatus" AND expires_at <= clock_timestamp()
          ORDER BY expires_at LIMIT ${batch} FOR UPDATE SKIP LOCKED
        )
        RETURNING id::text, errand_id::text
      `;
      for (const row of due) {
        await this.outbox.add(tx, {
          eventType: 'boost.expired',
          aggregateType: 'errand',
          aggregateId: row.errand_id,
          payload: { boostId: row.id, errandId: row.errand_id, reason: 'TIME_ELAPSED' },
        });
      }
      return due.length;
    });
  }

  /** Errands with a boost running right now, on the database clock (the feed's pin list). */
  async activeBoostedErrandIds(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ errand_id: string }>>`
      SELECT errand_id::text FROM boosts
      WHERE status = 'ACTIVE'::"BoostStatus" AND activates_at <= clock_timestamp() AND expires_at > clock_timestamp()
      ORDER BY activates_at
    `;
    return rows.map((r) => r.errand_id);
  }

  async maxHours(): Promise<number> {
    return this.config.get('PRIORITY_BOOST_MAX_HOURS');
  }
}

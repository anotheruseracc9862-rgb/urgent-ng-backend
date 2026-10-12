import { Injectable } from '@nestjs/common';
import { AuditActorType, Prisma, type SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { SUBSCRIPTION_NOT_ACTIVE } from '../common/constants/error-codes.js';
import { addDays, nextProPeriod } from '../billing/billing.rules.js';

export interface ProView {
  /** The runner has Pro benefits right now. */
  active: boolean;
  status: SubscriptionStatus | 'NONE';
  currentPeriodEnd: Date | null;
  graceEndsAt: Date | null;
  autoRenew: boolean;
  cancelledAt: Date | null;
}

interface SubRow {
  id: string;
  status: SubscriptionStatus;
  current_period_start: Date;
  current_period_end: Date;
  grace_ends_at: Date | null;
  auto_renew: boolean;
  version: number;
  db_now: Date;
}

const LIVE_SQL = Prisma.raw(`'TRIAL'::"SubscriptionStatus", 'ACTIVE'::"SubscriptionStatus", 'PENDING_RENEWAL'::"SubscriptionStatus",
  'PAYMENT_FAILED'::"SubscriptionStatus", 'GRACE_PERIOD'::"SubscriptionStatus", 'CANCELLED'::"SubscriptionStatus"`);

/**
 * Runner Pro, the state side (Backend PRD 22.4): a prepaid 30-day plan with optional auto-renew.
 * Charging is BillingModule's job (it owns payments); this service owns the states and the periods.
 *
 *   ACTIVE -> PENDING_RENEWAL -> ACTIVE          renewed
 *                  \\-> PAYMENT_FAILED -> GRACE_PERIOD -> ACTIVE (paid) | EXPIRED
 *   ACTIVE | CANCELLED --(period ends, no auto-renew)--> EXPIRED
 *
 * Benefits are the RUNNER_PRO entitlement rows: one per period, plus one over the grace days.
 * They stop when the entitlement's `valid_until` passes, with no sweeper involved; the sweeper
 * only tidies the state and raises the event. Already-submitted offers are untouched by expiry.
 */
@Injectable()
export class ProSubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: BusinessConfigService,
  ) {}

  async current(userId: string): Promise<ProView> {
    const rows = await this.prisma.$queryRaw<
      Array<{ status: SubscriptionStatus; current_period_end: Date; grace_ends_at: Date | null; auto_renew: boolean; cancelled_at: Date | null; active: boolean }>
    >`
      SELECT s.status, s.current_period_end, s.grace_ends_at, s.auto_renew, s.cancelled_at,
             EXISTS (
               SELECT 1 FROM entitlements e
               WHERE e.user_id = s.user_id AND e.type = 'RUNNER_PRO'::"EntitlementType" AND e.revoked_at IS NULL
                 AND e.valid_from <= clock_timestamp() AND (e.valid_until IS NULL OR e.valid_until > clock_timestamp())
             ) AS active
      FROM subscriptions s
      WHERE s.user_id = ${userId}::uuid
      ORDER BY (s.status IN ('EXPIRED'::"SubscriptionStatus")) ASC, s.created_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { active: false, status: 'NONE', currentPeriodEnd: null, graceEndsAt: null, autoRenew: false, cancelledAt: null };
    return {
      active: row.active,
      status: row.status,
      currentPeriodEnd: row.current_period_end,
      graceEndsAt: row.grace_ends_at,
      autoRenew: row.auto_renew,
      cancelledAt: row.cancelled_at,
    };
  }

  /**
   * A Runner Pro payment landed: open the subscription or extend it by one period, and grant the
   * entitlement for that period. Called inside the settlement transaction. Idempotent per order:
   * the entitlement's unique key is (subscription, type, period start).
   */
  async applyPayment(
    tx: Prisma.TransactionClient,
    input: { userId: string; orderId: string; autoRenew: boolean | null; days: number },
  ): Promise<{ subscriptionId: string; periodStart: Date; periodEnd: Date; extended: boolean }> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pro:${input.userId}`}))`;
    const existing = await tx.$queryRaw<SubRow[]>`
      SELECT id::text, status, current_period_start, current_period_end, grace_ends_at, auto_renew, version, clock_timestamp() AS db_now
      FROM subscriptions
      WHERE user_id = ${input.userId}::uuid AND status IN (${LIVE_SQL})
      FOR UPDATE
    `;
    const now = existing[0]?.db_now ?? (await this.dbNow(tx));
    const sub = existing[0];
    const running = sub && sub.current_period_end.getTime() > now.getTime() ? sub.current_period_end : null;
    const period = nextProPeriod({ now, currentEnd: running, days: input.days });

    let subscriptionId: string;
    if (!sub) {
      const created = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO subscriptions (user_id, status, current_period_start, current_period_end, auto_renew, latest_order_id, updated_at)
        VALUES (${input.userId}::uuid, 'ACTIVE'::"SubscriptionStatus", ${period.start}::timestamptz, ${period.end}::timestamptz,
                ${input.autoRenew === true}, ${input.orderId}::uuid, clock_timestamp())
        RETURNING id::text
      `;
      subscriptionId = created[0].id;
    } else {
      subscriptionId = sub.id;
      await tx.$executeRaw`
        UPDATE subscriptions
        SET status = 'ACTIVE'::"SubscriptionStatus",
            current_period_start = ${running ? sub.current_period_start : period.start}::timestamptz,
            current_period_end = ${period.end}::timestamptz,
            grace_ends_at = NULL, cancelled_at = NULL,
            auto_renew = ${input.autoRenew ?? sub.auto_renew},
            latest_order_id = ${input.orderId}::uuid, renewal_attempted_at = NULL,
            version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${subscriptionId}::uuid
      `;
    }

    await tx.$executeRaw`
      INSERT INTO entitlements (user_id, type, source, source_id, valid_from, valid_until)
      VALUES (${input.userId}::uuid, 'RUNNER_PRO'::"EntitlementType", 'SUBSCRIPTION', ${subscriptionId}::uuid,
              ${period.start}::timestamptz, ${period.end}::timestamptz)
      ON CONFLICT ("source", "source_id", "type", "valid_from") WHERE "source_id" IS NOT NULL DO NOTHING
    `;
    await this.outbox.add(tx, {
      eventType: 'subscription.activated',
      aggregateType: 'user',
      aggregateId: input.userId,
      payload: { userId: input.userId, subscriptionId, orderId: input.orderId, periodEnd: period.end, extended: sub !== undefined },
    });
    await this.audit.recordInTransaction(tx, {
      actorType: AuditActorType.SYSTEM,
      action: sub ? 'subscription.extended' : 'subscription.created',
      entityType: 'subscription',
      entityId: subscriptionId,
      metadata: { userId: input.userId, orderId: input.orderId, periodEnd: period.end },
    });
    return { subscriptionId, periodStart: period.start, periodEnd: period.end, extended: sub !== undefined };
  }

  /**
   * An admin grants Runner Pro for a number of days, or extends a running period by that many (a
   * goodwill gesture, a support case). No order and no money: the period gets its own entitlement
   * row like any other, so the benefits stop on their own at `valid_until`.
   */
  async adminGrant(userId: string, days: number, adminId: string): Promise<{ subscriptionId: string; periodEnd: Date; extended: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pro:${userId}`}))`;
      const existing = await tx.$queryRaw<SubRow[]>`
        SELECT id::text, status, current_period_start, current_period_end, grace_ends_at, auto_renew, version, clock_timestamp() AS db_now
        FROM subscriptions WHERE user_id = ${userId}::uuid AND status IN (${LIVE_SQL}) FOR UPDATE
      `;
      const sub = existing[0];
      const now = sub?.db_now ?? (await this.dbNow(tx));
      const running = sub && sub.current_period_end.getTime() > now.getTime() ? sub.current_period_end : null;
      const period = nextProPeriod({ now, currentEnd: running, days });
      let subscriptionId: string;
      if (!sub) {
        const created = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO subscriptions (user_id, status, current_period_start, current_period_end, auto_renew, updated_at)
          VALUES (${userId}::uuid, 'ACTIVE'::"SubscriptionStatus", ${period.start}::timestamptz, ${period.end}::timestamptz, FALSE, clock_timestamp())
          RETURNING id::text
        `;
        subscriptionId = created[0].id;
      } else {
        subscriptionId = sub.id;
        await tx.$executeRaw`
          UPDATE subscriptions
          SET status = 'ACTIVE'::"SubscriptionStatus",
              current_period_start = ${running ? sub.current_period_start : period.start}::timestamptz,
              current_period_end = ${period.end}::timestamptz, grace_ends_at = NULL, cancelled_at = NULL,
              version = version + 1, updated_at = clock_timestamp()
          WHERE id = ${subscriptionId}::uuid
        `;
      }
      await tx.$executeRaw`
        INSERT INTO entitlements (user_id, type, source, source_id, valid_from, valid_until)
        VALUES (${userId}::uuid, 'RUNNER_PRO'::"EntitlementType", 'SUBSCRIPTION', ${subscriptionId}::uuid,
                ${period.start}::timestamptz, ${period.end}::timestamptz)
        ON CONFLICT ("source", "source_id", "type", "valid_from") WHERE "source_id" IS NOT NULL DO NOTHING
      `;
      await this.outbox.add(tx, {
        eventType: 'subscription.activated',
        aggregateType: 'user',
        aggregateId: userId,
        payload: { userId, subscriptionId, orderId: null, periodEnd: period.end, extended: sub !== undefined, byAdmin: true },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: adminId,
        action: sub ? 'subscription.extended_by_admin' : 'subscription.granted_by_admin',
        entityType: 'subscription',
        entityId: subscriptionId,
        metadata: { userId, days, periodEnd: period.end },
      });
      return { subscriptionId, periodEnd: period.end, extended: sub !== undefined };
    });
  }

  /** An admin ends Runner Pro now: the subscription expires and the entitlements stop at this moment. */
  async adminEnd(userId: string, adminId: string): Promise<ProView> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pro:${userId}`}))`;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE subscriptions
        SET status = 'EXPIRED'::"SubscriptionStatus", auto_renew = FALSE, version = version + 1, updated_at = clock_timestamp()
        WHERE user_id = ${userId}::uuid AND status IN (${LIVE_SQL})
        RETURNING id::text
      `;
      if (!rows[0]) throw DomainException.of(SUBSCRIPTION_NOT_ACTIVE);
      await tx.$executeRaw`
        UPDATE entitlements SET revoked_at = clock_timestamp()
        WHERE user_id = ${userId}::uuid AND type = 'RUNNER_PRO'::"EntitlementType" AND revoked_at IS NULL
          AND (valid_until IS NULL OR valid_until > clock_timestamp())
      `;
      await this.outbox.add(tx, {
        eventType: 'subscription.expired',
        aggregateType: 'user',
        aggregateId: userId,
        payload: { userId, subscriptionId: rows[0].id, byAdmin: true },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: adminId,
        action: 'subscription.ended_by_admin',
        entityType: 'subscription',
        entityId: rows[0].id,
        metadata: { userId },
      });
    });
    return this.current(userId);
  }

  /** The user stops auto-renew. Benefits last to the end of the paid period (Backend PRD 22.4). */
  async cancel(userId: string): Promise<ProView> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: SubscriptionStatus }>>`
        SELECT id::text, status FROM subscriptions
        WHERE user_id = ${userId}::uuid AND status IN (${LIVE_SQL}) FOR UPDATE
      `;
      const sub = rows[0];
      if (!sub || sub.status === 'CANCELLED') {
        if (!sub) throw DomainException.of(SUBSCRIPTION_NOT_ACTIVE);
        return; // already cancelled: nothing to do
      }
      await tx.$executeRaw`
        UPDATE subscriptions
        SET status = 'CANCELLED'::"SubscriptionStatus", auto_renew = FALSE, cancelled_at = clock_timestamp(),
            version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${sub.id}::uuid
      `;
      await this.outbox.add(tx, {
        eventType: 'subscription.cancelled',
        aggregateType: 'user',
        aggregateId: userId,
        payload: { userId, subscriptionId: sub.id },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'subscription.cancelled',
        entityType: 'subscription',
        entityId: sub.id,
      });
    });
    return this.current(userId);
  }

  /**
   * A renewal charge failed: the subscription moves to GRACE_PERIOD for `RUNNER_PRO_GRACE_DAYS`
   * after the period end, and benefits continue through those days (an entitlement covers them).
   */
  async markRenewalFailed(tx: Prisma.TransactionClient, subscriptionId: string, reason: string): Promise<void> {
    const graceDays = await this.config.get('RUNNER_PRO_GRACE_DAYS');
    const rows = await tx.$queryRaw<Array<{ user_id: string; current_period_end: Date; grace_ends_at: Date | null; status: SubscriptionStatus }>>`
      SELECT user_id::text, current_period_end, grace_ends_at, status FROM subscriptions WHERE id = ${subscriptionId}::uuid FOR UPDATE
    `;
    const sub = rows[0];
    if (!sub) return;
    const graceEnd = sub.grace_ends_at ?? addDays(sub.current_period_end, graceDays);
    await tx.$executeRaw`
      UPDATE subscriptions
      SET status = 'GRACE_PERIOD'::"SubscriptionStatus", grace_ends_at = ${graceEnd}::timestamptz,
          renewal_attempted_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp()
      WHERE id = ${subscriptionId}::uuid
    `;
    if (sub.status !== 'GRACE_PERIOD' && graceEnd.getTime() > sub.current_period_end.getTime()) {
      await tx.$executeRaw`
        INSERT INTO entitlements (user_id, type, source, source_id, valid_from, valid_until)
        VALUES (${sub.user_id}::uuid, 'RUNNER_PRO'::"EntitlementType", 'SUBSCRIPTION', ${subscriptionId}::uuid,
                ${sub.current_period_end}::timestamptz, ${graceEnd}::timestamptz)
        ON CONFLICT ("source", "source_id", "type", "valid_from") WHERE "source_id" IS NOT NULL DO NOTHING
      `;
      await this.outbox.add(tx, {
        eventType: 'subscription.payment_failed',
        aggregateType: 'user',
        aggregateId: sub.user_id,
        payload: { userId: sub.user_id, subscriptionId, graceEndsAt: graceEnd, reason },
      });
    }
  }

  /** End subscriptions whose paid time (and grace, if any) ran out, and raise the event. */
  async expireDue(batch = 100): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<Array<{ id: string; user_id: string }>>`
        UPDATE subscriptions
        SET status = 'EXPIRED'::"SubscriptionStatus", version = version + 1, updated_at = clock_timestamp()
        WHERE id IN (
          SELECT id FROM subscriptions
          WHERE (
              (status IN ('ACTIVE'::"SubscriptionStatus", 'CANCELLED'::"SubscriptionStatus") AND auto_renew = FALSE
                 AND current_period_end <= clock_timestamp())
              OR (status = 'GRACE_PERIOD'::"SubscriptionStatus" AND grace_ends_at <= clock_timestamp())
            )
          ORDER BY current_period_end LIMIT ${batch} FOR UPDATE SKIP LOCKED
        )
        RETURNING id::text, user_id::text
      `;
      for (const row of due) {
        await this.outbox.add(tx, {
          eventType: 'subscription.expired',
          aggregateType: 'user',
          aggregateId: row.user_id,
          payload: { userId: row.user_id, subscriptionId: row.id },
        });
        await this.audit.recordInTransaction(tx, {
          actorType: AuditActorType.SYSTEM,
          action: 'subscription.expired',
          entityType: 'subscription',
          entityId: row.id,
          metadata: { userId: row.user_id },
        });
      }
      return due.length;
    });
  }

  private async dbNow(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return rows[0].now;
  }
}

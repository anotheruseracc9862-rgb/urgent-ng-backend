import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { ClockService } from '../common/utils/time.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { OFFER_DAILY_LIMIT_REACHED } from '../common/constants/error-codes.js';

export interface OfferLimitStatus {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: Date;
  isPro: boolean;
  isAtLimit: boolean;
}

export interface OfferLimitPolicy {
  isPro(userId: string): Promise<boolean> | boolean;
}

export interface OfferAllowance {
  value: number;
  isPro: boolean;
}

export const OFFER_LIMIT_POLICY = Symbol('OFFER_LIMIT_POLICY');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A runner's per-day offer allowance (Backend PRD 13.6). The counter is `offer_daily_counters`,
 * one row per user and Lagos day. `reserve` is the only way to spend the allowance: it locks the
 * row, checks the limit and increments, inside the caller's transaction, so a rolled-back offer
 * never counts and parallel submits can never pass the limit.
 */
@Injectable()
export class OfferLimitService {
  private readonly policy: OfferLimitPolicy;

  constructor(
    private readonly config: BusinessConfigService,
    private readonly clock: ClockService,
    private readonly prisma: PrismaService,
    @Optional() @Inject(OFFER_LIMIT_POLICY) policy?: OfferLimitPolicy,
  ) {
    this.policy = policy ?? { isPro: async () => false };
  }

  async isPro(userId: string): Promise<boolean> {
    return this.policy.isPro(userId);
  }

  async getLimitStatus(userId: string): Promise<OfferLimitStatus> {
    const dayLagos = this.clock.lagosDay(this.clock.now());
    const [limit, isPro, row] = await Promise.all([
      this.allowanceFor(userId),
      this.policy.isPro(userId),
      this.prisma.offerDailyCounter.findUnique({ where: { userId_dayLagos: { userId, dayLagos } } }),
    ]);
    return this.status(row?.count ?? 0, limit.value, limit.isPro || isPro);
  }

  /**
   * Spend one offer from today's allowance. Throws `OFFER_DAILY_LIMIT_REACHED` (with `resetsAt`)
   * when none is left. The caller must create the offer in the same transaction.
   */
  async reserve(tx: Prisma.TransactionClient, userId: string, allowance?: OfferAllowance): Promise<OfferLimitStatus> {
    // Pass `allowance` (from `allowanceFor`, read before the transaction): a lookup here could need
    // a second pool connection while parallel transactions hold all of them and wait on this lock.
    const { value: limit, isPro } = allowance ?? (await this.allowanceFor(userId));
    const dayLagos = this.clock.lagosDay(this.clock.now());

    await tx.$executeRaw`
      INSERT INTO offer_daily_counters (user_id, day_lagos, count, updated_at)
      VALUES (${userId}::uuid, ${dayLagos}, 0, now())
      ON CONFLICT (user_id, day_lagos) DO NOTHING
    `;
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT count FROM offer_daily_counters
      WHERE user_id = ${userId}::uuid AND day_lagos = ${dayLagos}
      FOR UPDATE
    `;
    const used = rows[0]?.count ?? 0;
    if (used >= limit) {
      const status = this.status(used, limit, isPro);
      throw DomainException.of(OFFER_DAILY_LIMIT_REACHED, {
        message: "You have reached today's offer limit.",
        details: { used: status.used, limit: status.limit, remaining: 0, resetsAt: status.resetsAt },
      });
    }
    await tx.$executeRaw`
      UPDATE offer_daily_counters SET count = count + 1, updated_at = now()
      WHERE user_id = ${userId}::uuid AND day_lagos = ${dayLagos}
    `;
    return this.status(used + 1, limit, isPro);
  }

  /**
   * An admin gives the runner back offers today: all of them (`extra` left out), or `extra` more.
   * It only lowers today's counter, so it never raises a limit and never touches another day.
   */
  async adminAdjust(userId: string, extra?: number): Promise<OfferLimitStatus> {
    const dayLagos = this.clock.lagosDay(this.clock.now());
    await this.prisma.$executeRaw`
      INSERT INTO offer_daily_counters (user_id, day_lagos, count, updated_at)
      VALUES (${userId}::uuid, ${dayLagos}, 0, now())
      ON CONFLICT (user_id, day_lagos) DO NOTHING
    `;
    if (extra === undefined) {
      await this.prisma.$executeRaw`
        UPDATE offer_daily_counters SET count = 0, updated_at = now() WHERE user_id = ${userId}::uuid AND day_lagos = ${dayLagos}
      `;
    } else {
      await this.prisma.$executeRaw`
        UPDATE offer_daily_counters SET count = GREATEST(count - ${extra}::int, 0), updated_at = now()
        WHERE user_id = ${userId}::uuid AND day_lagos = ${dayLagos}
      `;
    }
    return this.getLimitStatus(userId);
  }

  /** The runner's daily allowance right now: the free limit, or the Pro fair-use cap. */
  async allowanceFor(userId: string): Promise<OfferAllowance> {
    const [freeLimit, proCap, isPro] = await Promise.all([
      this.config.get('FREE_RUNNER_DAILY_OFFER_LIMIT'),
      this.config.get('PRO_DAILY_OFFER_CAP'),
      this.policy.isPro(userId),
    ]);
    return { value: isPro ? proCap : freeLimit, isPro };
  }

  private status(used: number, limit: number, isPro: boolean): OfferLimitStatus {
    const resetsAt = new Date(this.clock.startOfDayLagos(this.clock.now()).getTime() + DAY_MS);
    return { used, limit, remaining: Math.max(limit - used, 0), resetsAt, isPro, isAtLimit: used >= limit };
  }
}

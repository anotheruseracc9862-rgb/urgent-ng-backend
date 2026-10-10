import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { ClockService } from '../common/utils/time.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { OfferDailyCounter } from './offer-daily-counter.js';

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

export const OFFER_LIMIT_POLICY = Symbol('OFFER_LIMIT_POLICY');

/**
 * Tracks a runner's per-day offer allowance. When Prisma is available the counter is durable and
 * updated in the same transaction as the offer creation; without the database this keeps the
 * original in-memory behavior for unit tests.
 */
@Injectable()
export class OfferLimitService {
  private readonly counters = new Map<string, OfferDailyCounter>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly config: BusinessConfigService,
    private readonly clock: ClockService,
    @Optional() @Inject(OFFER_LIMIT_POLICY)
    private readonly policy: OfferLimitPolicy = { isPro: async () => false },
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async getLimitStatus(userId: string): Promise<OfferLimitStatus> {
    const [freeLimit, proCap, isPro] = await Promise.all([
      this.config.get('FREE_RUNNER_DAILY_OFFER_LIMIT'),
      this.config.get('PRO_DAILY_OFFER_CAP'),
      this.policy.isPro(userId),
    ]);

    const limit = isPro ? proCap : freeLimit;
    const used = await this.getUsedCount(userId);
    const remaining = Math.max(limit - used, 0);
    const resetsAt = this.nextResetAt();

    return {
      used,
      limit,
      remaining,
      resetsAt,
      isPro,
      isAtLimit: used >= limit,
    };
  }

  async consume(userId: string, count: number = 1, tx?: Prisma.TransactionClient): Promise<OfferLimitStatus> {
    if (this.prisma) {
      if (tx) {
        return this.consumeInDatabase(userId, count, tx);
      }
      return this.consumeInDatabase(userId, count);
    }

    const key = this.counterKey(userId);
    const result = await this.withLock(key, async () => {
      const status = await this.getLimitStatus(userId);
      const safeDelta = Math.max(0, Math.min(count, Math.max(0, status.limit - status.used)));
      const current = this.getOrCreateCounter(userId);
      const nextUsed = Math.min(status.limit, current.increment(safeDelta));

      this.counters.set(key, new OfferDailyCounter(userId, current.dayLagos, nextUsed));

      const remaining = Math.max(status.limit - nextUsed, 0);
      return {
        ...status,
        used: nextUsed,
        remaining,
        isAtLimit: nextUsed >= status.limit,
      };
    });

    return result;
  }

  private async consumeInDatabase(userId: string, count: number, tx?: Prisma.TransactionClient): Promise<OfferLimitStatus> {
    const [freeLimit, proCap, isPro] = await Promise.all([
      this.config.get('FREE_RUNNER_DAILY_OFFER_LIMIT'),
      this.config.get('PRO_DAILY_OFFER_CAP'),
      this.policy.isPro(userId),
    ]);

    const limit = isPro ? proCap : freeLimit;
    const dayLagos = this.clock.lagosDay(this.clock.now());

    if (tx) {
      const existing = await tx.offerDailyCounter.findUnique({
        where: { userId_dayLagos: { userId, dayLagos } },
      });

      const used = existing?.count ?? 0;
      const safeDelta = Math.max(0, Math.min(count, Math.max(0, limit - used)));
      const nextUsed = Math.min(limit, used + safeDelta);

      await tx.offerDailyCounter.upsert({
        where: { userId_dayLagos: { userId, dayLagos } },
        create: { userId, dayLagos, count: nextUsed },
        update: { count: nextUsed, updatedAt: new Date() },
      });

      return {
        used: nextUsed,
        limit,
        remaining: Math.max(limit - nextUsed, 0),
        resetsAt: this.nextResetAt(),
        isPro,
        isAtLimit: nextUsed >= limit,
      } satisfies OfferLimitStatus;
    }

    return this.prisma!.$transaction(async (transaction) => this.consumeInDatabase(userId, count, transaction));
  }

  private async getUsedCount(userId: string): Promise<number> {
    if (this.prisma) {
      const dayLagos = this.clock.lagosDay(this.clock.now());
      const row = await this.prisma.offerDailyCounter.findUnique({
        where: { userId_dayLagos: { userId, dayLagos } },
      });
      return row?.count ?? 0;
    }

    const counter = this.getOrCreateCounter(userId);
    return counter.count;
  }

  private getOrCreateCounter(userId: string): OfferDailyCounter {
    const day = this.clock.lagosDay(this.clock.now());
    const key = OfferDailyCounter.key(userId, day);
    const existing = this.counters.get(key);
    if (existing) {
      return existing;
    }

    const fresh = new OfferDailyCounter(userId, day, 0);
    this.counters.set(key, fresh);
    return fresh;
  }

  private counterKey(userId: string): string {
    return OfferDailyCounter.key(userId, this.clock.lagosDay(this.clock.now()));
  }

  private nextResetAt(): Date {
    const start = this.clock.startOfDayLagos(this.clock.now());
    return new Date(start.getTime() + 24 * 60 * 60 * 1000);
  }

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}

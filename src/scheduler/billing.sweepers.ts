import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { BoostService } from '../boosts/boost.service.js';
import { ProSubscriptionService } from '../subscriptions/pro-subscription.service.js';
import { ProRenewalService } from '../billing/pro-renewal.service.js';
import { ReconciliationService } from '../billing/reconciliation.service.js';

/** Ends boosts whose time ran out (Backend PRD 22.5). */
@Injectable()
export class BoostExpirySweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly boosts: BoostService,
  ) {
    super(prisma, 'BoostExpirySweeper');
  }

  protected async processBatch(): Promise<number> {
    return this.boosts.expireDue();
  }
}

/**
 * Runner Pro housekeeping (Backend PRD 22.4): charge renewals that are due, then end the
 * subscriptions whose paid time and grace are over. Benefits stop on their own at the
 * entitlement's end; this keeps the state and the events honest.
 */
@Injectable()
export class SubscriptionSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly renewals: ProRenewalService,
    private readonly subscriptions: ProSubscriptionService,
  ) {
    super(prisma, 'SubscriptionSweeper');
  }

  protected async processBatch(): Promise<number> {
    const renewed = await this.renewals.renewDue();
    const expired = await this.subscriptions.expireDue();
    return renewed + expired;
  }
}

/**
 * The daily reconciliation against the gateway (Backend PRD 22.2). The sweeper wakes every
 * minute like the others; a Redis marker with a 24 hour life makes the work happen once a day
 * across any number of scheduler processes. If Redis is down it skips, and tomorrow catches up.
 */
@Injectable()
export class ReconciliationSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly reconciliation: ReconciliationService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super(prisma, 'ReconciliationSweeper');
  }

  protected async processBatch(): Promise<number> {
    try {
      const first = await this.redis.set('billing:reconciliation:last-run', new Date().toISOString(), 'EX', 24 * 3600, 'NX');
      if (first === null) return 0;
    } catch {
      return 0;
    }
    const report = await this.reconciliation.run();
    this.logger.log(`Reconciliation: ${JSON.stringify(report)}`);
    return report.checked;
  }
}

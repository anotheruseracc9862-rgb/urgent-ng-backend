import { describe, expect, it } from 'vitest';
import { ClockService } from '../common/utils/time.service.js';
import { OfferLimitService } from './offer-limit.service.js';

function makeConfig(overrides: Partial<Record<'FREE_RUNNER_DAILY_OFFER_LIMIT' | 'PRO_DAILY_OFFER_CAP', number>> = {}) {
  return {
    get: async (key: 'FREE_RUNNER_DAILY_OFFER_LIMIT' | 'PRO_DAILY_OFFER_CAP') => {
      const values = {
        FREE_RUNNER_DAILY_OFFER_LIMIT: 10,
        PRO_DAILY_OFFER_CAP: 100,
        ...overrides,
      };
      return values[key];
    },
  } as any;
}

function makeClock(nowIso: string): ClockService {
  return {
    now: () => new Date(nowIso),
    lagosDay: (date: Date) => new ClockService().lagosDay(date),
    startOfDayLagos: (date: Date) => new ClockService().startOfDayLagos(date),
  } as unknown as ClockService;
}

describe('OfferLimitService', () => {
  it('returns the default daily free-runner limit and reset time in Lagos time', async () => {
    const service = new OfferLimitService(makeConfig(), makeClock('2024-01-15T14:30:00.000Z'), {
      isPro: async () => false,
    });

    const status = await service.getLimitStatus('runner-1');
    const expectedReset = new Date(
      new ClockService().startOfDayLagos(new Date('2024-01-15T14:30:00.000Z')).getTime() + 24 * 60 * 60 * 1000,
    );

    expect(status.used).toBe(0);
    expect(status.limit).toBe(10);
    expect(status.remaining).toBe(10);
    expect(status.isPro).toBe(false);
    expect(status.isAtLimit).toBe(false);
    expect(status.resetsAt.getTime()).toBe(expectedReset.getTime());
  });

  it('uses the pro cap when the runner is pro and caps consumption at the limit', async () => {
    const service = new OfferLimitService(makeConfig(), makeClock('2024-01-15T18:00:00.000Z'), {
      isPro: async () => true,
    });

    const status = await service.consume('runner-pro', 5);
    expect(status.used).toBe(5);
    expect(status.limit).toBe(100);
    expect(status.remaining).toBe(95);

    const capped = await service.consume('runner-pro', 200);
    expect(capped.used).toBe(100);
    expect(capped.remaining).toBe(0);
    expect(capped.isAtLimit).toBe(true);
  });

  it('resets the counter on the next Lagos day boundary', async () => {
    const service = new OfferLimitService(makeConfig(), makeClock('2024-01-15T23:30:00.000Z'), {
      isPro: async () => false,
    });

    await service.consume('runner-1', 4);
    expect((await service.getLimitStatus('runner-1')).used).toBe(4);

    const nextDayService = new OfferLimitService(makeConfig(), makeClock('2024-01-16T00:30:00.000Z'), {
      isPro: async () => false,
    });

    const status = await nextDayService.getLimitStatus('runner-1');
    expect(status.used).toBe(0);
    expect(status.remaining).toBe(10);
  });

  it('never exceeds the limit under concurrent increments', async () => {
    const service = new OfferLimitService(makeConfig(), makeClock('2024-01-15T10:00:00.000Z'), {
      isPro: async () => false,
    });

    await Promise.all(
      Array.from({ length: 30 }, () => service.consume('runner-1', 1)),
    );

    const status = await service.getLimitStatus('runner-1');
    expect(status.used).toBe(10);
    expect(status.remaining).toBe(0);
    expect(status.isAtLimit).toBe(true);
  });
});

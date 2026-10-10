import { describe, expect, it } from 'vitest';
import { ClockService } from '../common/utils/time.service.js';
import { OfferLimitService } from './offer-limit.service.js';

function makeConfig() {
  const values: Record<string, number> = { FREE_RUNNER_DAILY_OFFER_LIMIT: 10, PRO_DAILY_OFFER_CAP: 100 };
  return { get: async (key: string) => values[key] } as never;
}

function makeClock(nowIso: string): ClockService {
  const real = new ClockService();
  return Object.assign(Object.create(real), { now: () => new Date(nowIso) }) as ClockService;
}

/** `used` is what the counter row holds today; the SQL path of `reserve` is covered by the integration suite. */
function makePrisma(used: number | null) {
  return { offerDailyCounter: { findUnique: async () => (used === null ? null : { count: used }) } } as never;
}

describe('OfferLimitService.getLimitStatus', () => {
  it('reports the free limit, remaining allowance and the next Lagos midnight', async () => {
    const clock = makeClock('2024-01-15T14:30:00.000Z');
    const service = new OfferLimitService(makeConfig(), clock, makePrisma(3));

    const status = await service.getLimitStatus('runner-1');

    expect(status).toMatchObject({ used: 3, limit: 10, remaining: 7, isPro: false, isAtLimit: false });
    expect(status.resetsAt.getTime()).toBe(clock.startOfDayLagos(clock.now()).getTime() + 24 * 60 * 60 * 1000);
  });

  it('is at the limit when used reaches it, and never reports negative remaining', async () => {
    const service = new OfferLimitService(makeConfig(), makeClock('2024-01-15T10:00:00.000Z'), makePrisma(12));

    const status = await service.getLimitStatus('runner-1');

    expect(status).toMatchObject({ used: 12, remaining: 0, isAtLimit: true });
  });

  it('uses the fair-use cap for an active Runner Pro', async () => {
    const service = new OfferLimitService(makeConfig(), makeClock('2024-01-15T18:00:00.000Z'), makePrisma(50), {
      isPro: async () => true,
    });

    const status = await service.getLimitStatus('runner-pro');

    expect(status).toMatchObject({ limit: 100, remaining: 50, isPro: true, isAtLimit: false });
  });

  it('starts at zero when there is no counter row for the day', async () => {
    const service = new OfferLimitService(makeConfig(), makeClock('2024-01-16T00:30:00.000Z'), makePrisma(null));

    expect(await service.getLimitStatus('runner-1')).toMatchObject({ used: 0, remaining: 10 });
  });
});

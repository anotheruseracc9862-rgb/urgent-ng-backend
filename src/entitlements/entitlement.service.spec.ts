import { describe, expect, it } from 'vitest';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { EntitlementService } from './entitlement.service.js';

function makeOfferLimitService(overrides: Partial<Record<string, any>> = {}) {
  return {
    getLimitStatus: async (userId: string) => ({
      used: overrides.used ?? 0,
      limit: overrides.limit ?? 10,
      remaining: overrides.remaining ?? 10,
      resetsAt: new Date('2024-01-16T00:00:00.000Z'),
      isPro: overrides.isPro ?? false,
      isAtLimit: overrides.isAtLimit ?? false,
      userId,
    }),
    consume: async () => ({
      used: overrides.used ?? 0,
      limit: overrides.limit ?? 10,
      remaining: overrides.remaining ?? 10,
      resetsAt: new Date('2024-01-16T00:00:00.000Z'),
      isPro: overrides.isPro ?? false,
      isAtLimit: overrides.isAtLimit ?? false,
    }),
  } as any;
}

describe('EntitlementService', () => {
  it('allows a free runner before the daily limit is reached', async () => {
    const service = new EntitlementService(makeOfferLimitService({ used: 3, limit: 10, remaining: 7, isAtLimit: false }));

    const outcome = await service.canSubmitOffer('runner-1');

    expect(outcome.allowed).toBe(true);
    expect(outcome.reason).toBeUndefined();
    expect(outcome.remaining).toBe(7);
  });

  it('blocks a free runner when the daily limit has been reached', async () => {
    const service = new EntitlementService(makeOfferLimitService({ used: 10, limit: 10, remaining: 0, isAtLimit: true }));

    const outcome = await service.canSubmitOffer('runner-1');

    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe('OFFER_DAILY_LIMIT_REACHED');
  });

  it('throws a domain exception when offer submission is not allowed', async () => {
    const service = new EntitlementService(makeOfferLimitService({ used: 10, limit: 10, remaining: 0, isAtLimit: true }));

    await expect(service.assertCanSubmitOffer('runner-1')).rejects.toBeInstanceOf(DomainException);
  });
});

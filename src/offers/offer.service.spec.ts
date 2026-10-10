import { describe, expect, it, vi } from 'vitest';
import { OfferService } from './offer.service.js';

function makeService(overrides: { assertCanOffer?: () => Promise<void> } = {}) {
  const config = {
    get: async (key: string) =>
      ({
        OFFER_MIN_AMOUNT: 20_000,
        OFFER_MAX_AMOUNT: 50_000_000,
        OFFER_DURATION_MIN_MINUTES: 5,
        OFFER_DURATION_MAX_MINUTES: 1440,
        MAX_OPEN_OFFERS_PER_RUNNER: 20,
      })[key],
  };
  const prisma = { $transaction: vi.fn() };
  const eligibility = { assertCanOffer: overrides.assertCanOffer ?? (async () => undefined) };
  const service = new OfferService(config as never, {} as never, eligibility as never, prisma as never, {} as never, {} as never, {} as never);
  return { service, prisma };
}

const input = { errandId: 'e', runnerId: 'r', amountMinor: 50_000, durationMinutes: 30, availabilityConfirmed: true };

// The transactional behaviour (locks, turns, limits, lifecycle) is covered by the integration suites.
describe('OfferService.submitOffer input checks', () => {
  it.each([
    ['amount below the minimum', { amountMinor: 100 }],
    ['amount above the maximum', { amountMinor: 999_999_999_999 }],
    ['fractional amount', { amountMinor: 25_000.5 }],
    ['duration below the minimum', { durationMinutes: 1 }],
    ['duration above the maximum', { durationMinutes: 5000 }],
    ['availability not confirmed', { availabilityConfirmed: false }],
  ])('rejects %s before touching the database', async (_label, override) => {
    const { service, prisma } = makeService();

    await expect(service.submitOffer({ ...input, ...override })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('stops at runner eligibility before opening a transaction', async () => {
    const { service, prisma } = makeService({
      assertCanOffer: async () => {
        throw new Error('not eligible');
      },
    });

    await expect(service.submitOffer(input)).rejects.toThrow('not eligible');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

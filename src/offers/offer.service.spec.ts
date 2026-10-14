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
  const prisma = { $transaction: vi.fn(), offer: { findFirst: vi.fn() } };
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

  describe('OfferService.getNegotiation', () => {
    it('limits negotiation history to one of the authenticated offer parties', async () => {
      const { service, prisma } = makeService();
      prisma.offer.findFirst.mockResolvedValue({
        id: 'offer-1',
        errandId: 'errand-1',
        runnerId: 'runner-1',
        requesterId: 'requester-1',
        amountMinor: 525000n,
        durationMinutes: 30,
        status: 'ACTIVE',
        awaitingParty: 'REQUESTER',
        version: 3,
        needsReconfirmation: false,
        closeReason: null,
        conversationId: 'conversation-1',
        createdAt: new Date('2026-10-14T10:00:00.000Z'),
        updatedAt: new Date('2026-10-14T10:10:00.000Z'),
        availabilityConfirmedAt: new Date('2026-10-14T10:00:00.000Z'),
        message: null,
        errand: { title: 'Pick up a cake' },
        assignments: [],
        negotiationEvents: [{
          id: 'event-1',
          messageType: 'INITIAL_OFFER',
          actorUserId: 'runner-1',
          proposedAmountMinor: 525000n,
          proposedDurationMinutes: 30,
          message: 'Available now',
          createdAt: new Date('2026-10-14T10:00:00.000Z'),
        }],
      });

      const result = await service.getNegotiation('offer-1', 'requester-1');

      expect(prisma.offer.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'offer-1', OR: [{ runnerId: 'requester-1' }, { requesterId: 'requester-1' }] },
      }));
      expect(result.history[0]).toMatchObject({ amountMinor: 525000, type: 'INITIAL_OFFER', actorUserId: 'runner-1' });
    });

    it('hides offers from callers who are not a party', async () => {
      const { service, prisma } = makeService();
      prisma.offer.findFirst.mockResolvedValue(null);

      await expect(service.getNegotiation('offer-1', 'other-user')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
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

import { describe, expect, it } from 'vitest';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { OfferService } from './offer.service.js';

function makeConfig() {
  return {
    get: async (key: string) => {
      const values: Record<string, number> = {
        OFFER_MIN_AMOUNT: 20000,
        OFFER_MAX_AMOUNT: 50000000,
        OFFER_DURATION_MIN_MINUTES: 5,
        OFFER_DURATION_MAX_MINUTES: 1440,
        MAX_OPEN_OFFERS_PER_RUNNER: 20,
      };
      return values[key];
    },
  } as any;
}

function makeEntitlement() {
  return {
    assertCanSubmitOffer: async () => undefined,
  } as any;
}

function makeOfferLimit() {
  return {
    consume: async () => ({ used: 1, limit: 10, remaining: 9, isAtLimit: false, resetsAt: new Date() }),
  } as any;
}

describe('OfferService', () => {
  it('submits a valid offer and tracks the active bid', async () => {
    const service = new OfferService(makeConfig(), makeEntitlement(), makeOfferLimit());
    const errand = { id: 'errand-1', requesterId: 'req-1', status: 'OPEN' as const };

    const offer = await service.submitOffer({
      errand,
      runnerId: 'runner-1',
      amountMinor: 25000,
      durationMinutes: 30,
      availabilityConfirmedAt: new Date('2024-01-15T09:00:00.000Z'),
    });

    expect(offer.status).toBe('ACTIVE');
    expect(offer.awaitingParty).toBe('REQUESTER');
    expect(service.getLiveOffersForErrand('errand-1')).toHaveLength(1);
  });

  it('rejects duplicate active offers per errand and runner', async () => {
    const service = new OfferService(makeConfig(), makeEntitlement(), makeOfferLimit());
    const errand = { id: 'errand-2', requesterId: 'req-2', status: 'OPEN' as const };

    await service.submitOffer({
      errand,
      runnerId: 'runner-2',
      amountMinor: 28000,
      durationMinutes: 45,
      availabilityConfirmedAt: new Date('2024-01-15T09:00:00.000Z'),
    });

    await expect(
      service.submitOffer({
        errand,
        runnerId: 'runner-2',
        amountMinor: 30000,
        durationMinutes: 50,
        availabilityConfirmedAt: new Date('2024-01-15T09:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(DomainException);
  });

  it('supports countering and withdrawing an offer', async () => {
    const service = new OfferService(makeConfig(), makeEntitlement(), makeOfferLimit());
    const errand = { id: 'errand-3', requesterId: 'req-3', status: 'OPEN' as const };

    const offer = await service.submitOffer({
      errand,
      runnerId: 'runner-3',
      amountMinor: 20000,
      durationMinutes: 20,
      availabilityConfirmedAt: new Date('2024-01-15T09:00:00.000Z'),
    });

    const countered = await service.counterOffer(offer.id, 'REQUESTER', 24000, 25, 'Can you do 24k?');
    expect(countered.amountMinor).toBe(24000);
    expect(countered.awaitingParty).toBe('RUNNER');
    const withdrawn = await service.withdraw(offer.id);
    expect(withdrawn.status).toBe('WITHDRAWN');
  });

  it('requires a matching turn and rejects stale versions', async () => {
    const service = new OfferService(makeConfig(), makeEntitlement(), makeOfferLimit());
    const errand = { id: 'errand-4', requesterId: 'req-4', status: 'OPEN' as const };

    const offer = await service.submitOffer({
      errand,
      runnerId: 'runner-4',
      amountMinor: 21000,
      durationMinutes: 22,
      availabilityConfirmedAt: new Date('2024-01-15T09:00:00.000Z'),
    });

    await expect(service.counterOffer(offer.id, 'RUNNER', 22000, 24)).rejects.toBeInstanceOf(DomainException);
    await expect(service.counterOffer(offer.id, 'REQUESTER', 22000, 24, undefined, 99)).rejects.toBeInstanceOf(DomainException);

    service.flagForReconfirmation(errand.id);
    await expect(service.reconfirmOffer(offer.id, undefined, 'runner-4')).resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('rejects withdraw and reconfirm calls from the wrong runner', async () => {
    const service = new OfferService(makeConfig(), makeEntitlement(), makeOfferLimit());
    const errand = { id: 'errand-5', requesterId: 'req-5', status: 'OPEN' as const };

    const offer = await service.submitOffer({
      errand,
      runnerId: 'runner-5',
      amountMinor: 23000,
      durationMinutes: 26,
      availabilityConfirmedAt: new Date('2024-01-15T09:00:00.000Z'),
    });

    service.flagForReconfirmation(errand.id);

    await expect(service.withdraw(offer.id, 'other-runner')).rejects.toBeInstanceOf(DomainException);
    await expect(service.reconfirmOffer(offer.id, undefined, 'other-runner')).rejects.toBeInstanceOf(DomainException);
  });
});

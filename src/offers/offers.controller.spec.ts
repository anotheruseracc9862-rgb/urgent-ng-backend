import { describe, expect, it, vi } from 'vitest';
import { OffersController } from './offers.controller.js';

function makeController() {
  const offers = {
    submitOffer: vi.fn().mockResolvedValue({ id: 'offer-1' }),
    getNegotiation: vi.fn().mockResolvedValue({ id: 'offer-1', history: [] }),
    edit: vi.fn().mockResolvedValue({}),
    counterOffer: vi.fn().mockResolvedValue({}),
    acceptCounter: vi.fn().mockResolvedValue({}),
    withdraw: vi.fn().mockResolvedValue({}),
    rejectOffer: vi.fn().mockResolvedValue({}),
    reconfirmOffer: vi.fn().mockResolvedValue({}),
  };
  const offerList = { getOffersForErrand: vi.fn().mockResolvedValue([]) };
  return { controller: new OffersController(offers as never, offerList as never), offers, offerList };
}

const user = { userId: 'user-1' } as never;

describe('OffersController', () => {
  it('submits for the signed-in user and passes no errand context from the client', async () => {
    const { controller, offers } = makeController();

    // A client may still send these fields; the DTO no longer declares them and the call ignores them.
    const body = { amountMinor: 25_000, durationMinutes: 30, availabilityConfirmed: true, message: 'Hi', requesterId: 'x', status: 'OPEN' };
    await controller.submit(user, 'errand-1', body as never);

    expect(offers.submitOffer).toHaveBeenCalledWith({
      errandId: 'errand-1',
      runnerId: 'user-1',
      amountMinor: 25_000,
      durationMinutes: 30,
      availabilityConfirmed: true,
      message: 'Hi',
    });
  });

  it('passes the caller through every negotiation action', async () => {
    const { controller, offers } = makeController();

    await controller.edit(user, 'o', { amountMinor: 30_000, durationMinutes: 20 });
    await controller.counter(user, 'o', { amountMinor: 30_000, durationMinutes: 20, expectedVersion: 2 });
    await controller.acceptCounter(user, 'o', { expectedVersion: 3 });
    await controller.withdraw(user, 'o');
    await controller.reject(user, 'o', {});
    await controller.reconfirm(user, 'o', { expectedVersion: 4 });

    expect(offers.edit).toHaveBeenCalledWith('o', 'user-1', expect.objectContaining({ amountMinor: 30_000 }));
    expect(offers.counterOffer).toHaveBeenCalledWith('o', 'user-1', expect.objectContaining({ expectedVersion: 2 }));
    expect(offers.acceptCounter).toHaveBeenCalledWith('o', 'user-1', 3);
    expect(offers.withdraw).toHaveBeenCalledWith('o', 'user-1');
    expect(offers.rejectOffer).toHaveBeenCalledWith('o', 'user-1', undefined);
    expect(offers.reconfirmOffer).toHaveBeenCalledWith('o', 'user-1', 4);
  });

  it('returns negotiation history only through the authenticated caller identity', async () => {
    const { controller, offers } = makeController();

    await controller.getNegotiation(user, 'offer-1');

    expect(offers.getNegotiation).toHaveBeenCalledWith('offer-1', 'user-1');
  });

  it('lists offers for the signed-in requester with the chosen sort', async () => {
    const { controller, offerList } = makeController();

    await controller.list(user, 'errand-1', { sort: 'eta_asc' });

    expect(offerList.getOffersForErrand).toHaveBeenCalledWith('user-1', 'errand-1', 'eta_asc');
  });
});

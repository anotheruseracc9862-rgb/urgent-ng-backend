import { describe, expect, it, vi } from 'vitest';
import { OffersController } from './offers.controller.js';

describe('OffersController', () => {
  it('submits a new offer for an errand', async () => {
    const service = {
      submitOffer: vi.fn().mockResolvedValue({ id: 'offer-1', status: 'ACTIVE' }),
      getLiveOffersForErrand: vi.fn().mockReturnValue([]),
      getOffer: vi.fn().mockReturnValue({ runnerId: 'runner-1', requesterId: 'requester-1' }),
      counterOffer: vi.fn(),
      rejectOffer: vi.fn(),
      withdraw: vi.fn(),
      reconfirmOffer: vi.fn(),
    } as any;

    const controller = new OffersController(service);
    const result = await controller.submit({ userId: 'runner-1' } as any, 'errand-1', {
      requesterId: 'requester-1',
      amountMinor: 25000,
      durationMinutes: 30,
      availabilityConfirmedAt: new Date('2024-01-15T09:00:00.000Z'),
      message: 'Happy to help',
      status: 'OPEN',
    });

    expect(result.id).toBe('offer-1');
    expect(service.submitOffer).toHaveBeenCalledWith(expect.objectContaining({ runnerId: 'runner-1', errand: expect.objectContaining({ id: 'errand-1' }) }));
  });

  it('passes the current user through withdraw and reconfirm actions', () => {
    const service = {
      withdraw: vi.fn().mockReturnValue({ id: 'offer-1', status: 'WITHDRAWN' }),
      reconfirmOffer: vi.fn().mockReturnValue({ id: 'offer-1', status: 'ACTIVE' }),
      getLiveOffersForErrand: vi.fn(),
      getOffer: vi.fn(),
      submitOffer: vi.fn(),
      counterOffer: vi.fn(),
      rejectOffer: vi.fn(),
    } as any;

    const controller = new OffersController(service);

    controller.withdraw({ userId: 'runner-1' } as any, 'offer-1');
    controller.reconfirm({ userId: 'runner-1' } as any, 'offer-1', { expectedVersion: 2 });

    expect(service.withdraw).toHaveBeenCalledWith('offer-1', 'runner-1');
    expect(service.reconfirmOffer).toHaveBeenCalledWith('offer-1', 2, 'runner-1');
  });

  it('rejects a non-party user from negotiating the offer', () => {
    const service = {
      getOffer: vi.fn().mockReturnValue({ runnerId: 'runner-1', requesterId: 'requester-1' }),
      getLiveOffersForErrand: vi.fn(),
      submitOffer: vi.fn(),
      counterOffer: vi.fn(),
      rejectOffer: vi.fn(),
      withdraw: vi.fn(),
      reconfirmOffer: vi.fn(),
    } as any;

    const controller = new OffersController(service);

    expect(() => controller.counter({ userId: 'ghost-user' } as any, 'offer-1', { amountMinor: 25000, durationMinutes: 30 })).toThrow(/not a party/i);
  });

  it('lists live offers for an errand', () => {
    const service = {
      getLiveOffersForErrand: vi.fn().mockReturnValue([{ id: 'offer-1' }]),
      getOffer: vi.fn(),
      submitOffer: vi.fn(),
      counterOffer: vi.fn(),
      rejectOffer: vi.fn(),
      withdraw: vi.fn(),
      reconfirmOffer: vi.fn(),
    } as any;

    const controller = new OffersController(service);
    const result = controller.list('errand-1');

    expect(result).toHaveLength(1);
    expect(service.getLiveOffersForErrand).toHaveBeenCalledWith('errand-1');
  });
});

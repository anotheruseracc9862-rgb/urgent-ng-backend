import { describe, expect, it } from 'vitest';
import { NegotiationService } from './negotiation.service.js';

describe('NegotiationService', () => {
  it('records immutable history for an offer', () => {
    const service = new NegotiationService();

    const created = service.record({
      errandId: 'errand-1',
      offerId: 'offer-1',
      actorUserId: 'runner-1',
      messageType: 'INITIAL_OFFER',
      proposedAmountMinor: 25000,
      proposedDurationMinutes: 30,
      resultingOfferVersion: 1,
    });

    const counter = service.addEvent({
      errandId: 'errand-1',
      offerId: 'offer-1',
      actorUserId: 'requester-1',
      messageType: 'COUNTER_OFFER',
      proposedAmountMinor: 22000,
      proposedDurationMinutes: 25,
      resultingOfferVersion: 2,
    });

    expect(created.messageType).toBe('INITIAL_OFFER');
    expect(counter.messageType).toBe('COUNTER_OFFER');
    expect(service.list('offer-1')).toHaveLength(2);
  });
});

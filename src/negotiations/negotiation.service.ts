import { Injectable } from '@nestjs/common';
import { generateUuidV7 } from '../common/utils/uuid.helper.js';

export type NegotiationMessageType = 'INITIAL_OFFER' | 'COUNTER_OFFER' | 'ACCEPT' | 'REJECT' | 'WITHDRAW' | 'SYSTEM_EVENT';

export interface NegotiationEvent {
  id: string;
  errandId: string;
  offerId: string;
  actorUserId: string;
  messageType: NegotiationMessageType;
  proposedAmountMinor?: number;
  proposedDurationMinutes?: number;
  currency?: string;
  message?: string;
  createdAt: Date;
  resultingOfferVersion: number;
}

export interface NegotiationEventInput {
  errandId: string;
  offerId: string;
  actorUserId: string;
  messageType: NegotiationMessageType;
  proposedAmountMinor?: number;
  proposedDurationMinutes?: number;
  currency?: string;
  message?: string;
  resultingOfferVersion: number;
}

@Injectable()
export class NegotiationService {
  private readonly events = new Map<string, NegotiationEvent[]>();

  record(input: NegotiationEventInput): NegotiationEvent {
    const event: NegotiationEvent = {
      id: generateUuidV7(),
      errandId: input.errandId,
      offerId: input.offerId,
      actorUserId: input.actorUserId,
      messageType: input.messageType,
      proposedAmountMinor: input.proposedAmountMinor,
      proposedDurationMinutes: input.proposedDurationMinutes,
      currency: input.currency ?? 'NGN',
      message: input.message,
      createdAt: new Date(),
      resultingOfferVersion: input.resultingOfferVersion,
    };

    const current = this.events.get(input.offerId) ?? [];
    this.events.set(input.offerId, [...current, event]);
    return event;
  }

  addEvent(input: NegotiationEventInput): NegotiationEvent {
    return this.record(input);
  }

  list(offerId: string): NegotiationEvent[] {
    return [...(this.events.get(offerId) ?? [])];
  }

  getLatest(offerId: string): NegotiationEvent | undefined {
    const events = this.events.get(offerId) ?? [];
    return events[events.length - 1];
  }
}

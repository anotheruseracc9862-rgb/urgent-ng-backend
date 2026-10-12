import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventDispatcher, type DomainEvent, type DomainEventHandler } from '../queue/event-dispatcher.js';
import { NearbyMatchingService } from './nearby-matching.service.js';

/** Starts nearby-errand matching when an errand is published, finishes the delayed wave and sends the boost wave. */
@Injectable()
export class NearbyMatchingHandler implements DomainEventHandler, OnModuleInit {
  readonly name = 'NearbyMatchingHandler';

  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly matching: NearbyMatchingService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: DomainEvent): Promise<void> {
    const errandId = event.payload.errandId;
    if (typeof errandId !== 'string') return;
    const at = new Date(event.occurredAt);
    if (event.eventType === 'errand.published') {
      await this.matching.onPublished(errandId, at);
    } else if (event.eventType === 'boost.activated') {
      await this.matching.onBoosted(errandId, at);
    } else if (event.eventType === 'errand.nearby_delayed') {
      const ids = event.payload.runnerIds;
      await this.matching.onDelayed(errandId, Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [], at);
    }
  }
}

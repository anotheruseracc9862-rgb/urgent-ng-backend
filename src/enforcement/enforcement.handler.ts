import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventDispatcher, type DomainEvent, type DomainEventHandler } from '../queue/event-dispatcher.js';
import { EnforcementService } from './enforcement.service.js';

/**
 * Applies the ladder when a fact with points is recorded (Backend PRD 21.4). The ladder looks at
 * the rolling-window total, so running it twice for the same event changes nothing.
 */
@Injectable()
export class EnforcementEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = 'EnforcementEventHandler';

  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly enforcement: EnforcementService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: DomainEvent): Promise<void> {
    if (event.eventType !== 'reliability.recorded') return;
    const userId = event.payload.userId;
    if (typeof userId !== 'string') return;
    await this.enforcement.evaluate(userId);
  }
}

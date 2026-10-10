import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventDispatcher, type DomainEvent, type DomainEventHandler } from '../queue/event-dispatcher.js';
import { NotificationRules } from './notification-rules.js';
import { NotificationService } from './notification.service.js';

/** Turns domain events into notifications (Backend PRD 19.1). Idempotent through dedupe keys. */
@Injectable()
export class NotificationEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = 'NotificationEventHandler';

  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly rules: NotificationRules,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: DomainEvent): Promise<void> {
    const intents = await this.rules.intentsFor(event);
    // Every intent is attempted; a failure in one is raised after the others were tried.
    const failures: unknown[] = [];
    for (const intent of intents) {
      try {
        await this.notifications.notify(intent, new Date(event.occurredAt));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';

/** One outbox event as a queue job carries it (see OutboxPublisher). */
export interface DomainEvent {
  eventId: string;
  eventType: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string | Date;
}

/**
 * Something that reacts to domain events: notifications, realtime fan-out, nearby-errand
 * matching. A handler picks the event types it cares about and ignores the rest. Handlers must be
 * idempotent: a job is retried as a whole, so a handler can see the same event twice (Backend PRD
 * 25.1). Deterministic keys (notification dedupe keys, stream entries per event id) do that.
 */
export interface DomainEventHandler {
  readonly name: string;
  handle(event: DomainEvent): Promise<void>;
}

/**
 * Fans each event out to every registered handler. One failing handler does not stop the others;
 * the failure is rethrown afterwards so the job is retried (and the handlers that already
 * succeeded are safe to run again).
 */
@Injectable()
export class EventDispatcher {
  private readonly logger = new Logger(EventDispatcher.name);
  private readonly handlers: DomainEventHandler[] = [];

  register(handler: DomainEventHandler): void {
    if (!this.handlers.includes(handler)) {
      this.handlers.push(handler);
    }
  }

  get registered(): readonly string[] {
    return this.handlers.map((handler) => handler.name);
  }

  async dispatch(event: DomainEvent): Promise<void> {
    const failures: Array<{ handler: string; error: unknown }> = [];
    for (const handler of this.handlers) {
      try {
        await handler.handle(event);
      } catch (error) {
        this.logger.error(`${handler.name} failed on ${event.eventType} ${event.eventId}: ${error instanceof Error ? error.message : String(error)}`);
        failures.push({ handler: handler.name, error });
      }
    }
    if (failures.length > 0) {
      throw new Error(`Event ${event.eventType} ${event.eventId} failed in: ${failures.map((f) => f.handler).join(', ')}`);
    }
  }
}

/** Helpers for tests of event consumers (notifications, realtime, matching). */

import type { INestApplication } from '@nestjs/common';
import { OutboxStatus } from '@prisma/client';
import { getTestPrisma } from './database.helper.js';
import { EventDispatcher, type DomainEvent } from '../queue/event-dispatcher.js';

/**
 * Deliver the pending outbox events to the dispatcher in order, the way the worker would, and mark
 * them published. Returns the events that were dispatched. Errors from handlers are raised.
 *
 * `where` narrows the batch (an event type, an aggregate id) for tests that care about one event.
 */
export async function dispatchOutbox(
  app: INestApplication,
  where: { eventType?: string | string[]; aggregateId?: string } = {},
): Promise<DomainEvent[]> {
  const prisma = getTestPrisma();
  const types = where.eventType === undefined ? undefined : ([] as string[]).concat(where.eventType);
  const rows = await prisma.outboxEvent.findMany({
    where: {
      status: OutboxStatus.PENDING,
      ...(types ? { eventType: { in: types } } : {}),
      ...(where.aggregateId ? { aggregateId: where.aggregateId } : {}),
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  const dispatcher = app.get(EventDispatcher);
  const out: DomainEvent[] = [];
  for (const row of rows) {
    const event: DomainEvent = {
      eventId: row.id,
      eventType: row.eventType,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      payload: row.payload as Record<string, unknown>,
      occurredAt: row.occurredAt,
    };
    await dispatcher.dispatch(event);
    await prisma.outboxEvent.update({ where: { id: row.id }, data: { status: OutboxStatus.PUBLISHED } });
    out.push(event);
  }
  return out;
}

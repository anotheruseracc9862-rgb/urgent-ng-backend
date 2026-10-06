import { describe, expect, it } from 'vitest';
import {
  EVENT_TO_QUEUE_MAP,
  QUEUE_NAMES,
  getQueueForEvent,
} from './queue.registry.js';

describe('queue registry', () => {
  it('routes a known event type to its queue', () => {
    expect(getQueueForEvent('user.created')).toBe(QUEUE_NAMES.NOTIFICATIONS);
    expect(getQueueForEvent('execution.delivered')).toBe(QUEUE_NAMES.AUTO_COMPLETION);
  });

  it('throws for an unknown event type instead of guessing a queue', () => {
    expect(() => getQueueForEvent('errand.publihsed')).toThrow(/No queue mapped/);
  });

  it('only routes to queues that exist', () => {
    const queues = new Set<string>(Object.values(QUEUE_NAMES));

    for (const queue of Object.values(EVENT_TO_QUEUE_MAP)) {
      expect(queues.has(queue)).toBe(true);
    }
  });
});

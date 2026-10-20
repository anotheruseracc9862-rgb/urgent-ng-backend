/**
 * Outbox service integration tests (P1-04)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../database/database.module.js';
import { OutboxService, OutboxEventRow } from './outbox.service.js';
import {
  getTestPrisma,
  cleanDatabase,
} from '../test/database.helper.js';
import { testConfigModule } from '../test/test-modules.js';
import { OutboxStatus } from '@prisma/client';

describe('OutboxService (Integration)', () => {
  let service: OutboxService;
  let module: TestingModule;
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();

    module = await Test.createTestingModule({
      imports: [testConfigModule(), DatabaseModule],
      providers: [OutboxService],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  afterEach(async () => {
    service.stopPublisher();
    await module?.close();
  });

  const ok = vi.fn(async (_event: OutboxEventRow) => undefined);

  describe('add()', () => {
    it('adds an outbox event within a transaction', async () => {
      const eventId = await prisma.$transaction(async (tx) =>
        service.add(tx, {
          eventType: 'user.created',
          aggregateType: 'User',
          aggregateId: '00000000-0000-0000-0000-000000000001',
          payload: { userId: '00000000-0000-0000-0000-000000000001' },
        }),
      );

      const event = await prisma.outboxEvent.findUnique({ where: { id: eventId } });

      expect(event?.eventType).toBe('user.created');
      expect(event?.aggregateType).toBe('User');
      expect(event?.status).toBe(OutboxStatus.PENDING);
      expect(event?.attempts).toBe(0);
    });

    it('rolls back the outbox event if the transaction fails', async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await service.add(tx, { eventType: 'test.event', payload: { test: 'data' } });
          throw new Error('Transaction failed');
        }),
      ).rejects.toThrow('Transaction failed');

      expect(await prisma.outboxEvent.findMany()).toHaveLength(0);
    });

    it('supports delayed events', async () => {
      const eventId = await service.addStandalone({
        eventType: 'delayed.event',
        payload: {},
        delayMs: 5000,
      });

      const event = await prisma.outboxEvent.findUnique({ where: { id: eventId } });
      expect(event?.availableAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('publishPendingEvents()', () => {
    it('publishes each due event on its own and marks it PUBLISHED', async () => {
      const first = await service.addStandalone({ eventType: 'event.one', payload: { n: 1 } });
      const second = await service.addStandalone({ eventType: 'event.two', payload: { n: 2 } });
      const publish = vi.fn(async (_event: OutboxEventRow) => undefined);

      const count = await service.publishPendingEvents(publish);

      expect(count).toBe(2);
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish.mock.calls.map(([event]) => event.id)).toEqual([first, second]);

      for (const id of [first, second]) {
        const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
        expect(event.status).toBe(OutboxStatus.PUBLISHED);
        expect(event.attempts).toBe(1);
        expect(event.processedAt).not.toBeNull();
        expect(event.processingStartedAt).toBeNull();
      }
    });

    it('does not publish an event twice', async () => {
      await service.addStandalone({ eventType: 'event.one', payload: {} });

      await service.publishPendingEvents(ok);
      ok.mockClear();
      await service.publishPendingEvents(ok);

      expect(ok).not.toHaveBeenCalled();
    });

    it('a failing event does not block or re-send the others in the batch', async () => {
      const good = await service.addStandalone({ eventType: 'event.good', payload: {} });
      const bad = await service.addStandalone({ eventType: 'event.bad', payload: {} });
      const later = await service.addStandalone({ eventType: 'event.later', payload: {} });
      const publish = vi.fn(async (event: OutboxEventRow) => {
        if (event.id === bad) throw new Error('queue unavailable');
      });

      const count = await service.publishPendingEvents(publish);

      expect(count).toBe(2);
      expect(publish).toHaveBeenCalledTimes(3);

      const rows = await prisma.outboxEvent.findMany({ orderBy: { occurredAt: 'asc' } });
      expect(rows.map((row) => [row.id, row.status])).toEqual([
        [good, OutboxStatus.PUBLISHED],
        [bad, OutboxStatus.FAILED],
        [later, OutboxStatus.PUBLISHED],
      ]);
      expect(rows[1].attempts).toBe(1);
      expect(rows[1].lastError).toBe('queue unavailable');
      expect(rows[1].availableAt.getTime()).toBeGreaterThan(Date.now());
      expect(rows[1].processingStartedAt).toBeNull();
    });

    it('retries a failed event with exponential backoff', async () => {
      const id = await service.addStandalone({ eventType: 'event.retry', payload: {} });
      const fail = async () => {
        throw new Error('nope');
      };

      await service.publishPendingEvents(fail);
      const afterFirst = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });

      // not due yet: not picked up
      ok.mockClear();
      await service.publishPendingEvents(ok);
      expect(ok).not.toHaveBeenCalled();

      // make it due, fail again: backoff doubles (about 2s after the second failure)
      await prisma.$executeRaw`UPDATE outbox_events SET available_at = NOW() WHERE id = ${id}::uuid`;
      await service.publishPendingEvents(fail);
      const afterSecond = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });

      expect(afterSecond.attempts).toBe(2);
      // Measured on the database clock, the one the retry time is set and checked against.
      const [{ now }] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const firstDelay = afterFirst.availableAt.getTime() - now.getTime();
      const secondDelay = afterSecond.availableAt.getTime() - now.getTime();
      expect(firstDelay).toBeLessThanOrEqual(1000);
      expect(secondDelay).toBeGreaterThan(1000);
      expect(secondDelay).toBeLessThanOrEqual(2000);
    });

    it('dead-letters an event after 10 failed attempts', async () => {
      const id = await service.addStandalone({ eventType: 'event.doomed', payload: {} });
      await prisma.$executeRaw`UPDATE outbox_events SET attempts = 9 WHERE id = ${id}::uuid`;

      await service.publishPendingEvents(async () => {
        throw new Error('still broken');
      });

      const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
      expect(event.status).toBe(OutboxStatus.DEAD_LETTERED);
      expect(event.attempts).toBe(10);
      expect(event.lastError).toBe('still broken');
    });

    it('skips events that are not yet available', async () => {
      await service.addStandalone({ eventType: 'event.future', payload: {}, delayMs: 60_000 });

      ok.mockClear();
      const count = await service.publishPendingEvents(ok);

      expect(count).toBe(0);
      expect(ok).not.toHaveBeenCalled();
    });

    it('reclaims an event stuck in PROCESSING past the lease (crashed publisher)', async () => {
      const id = await service.addStandalone({ eventType: 'event.stuck', payload: {} });
      await prisma.$executeRaw`
        UPDATE outbox_events
        SET status = 'PROCESSING'::"OutboxStatus", processing_started_at = NOW() - INTERVAL '5 minutes'
        WHERE id = ${id}::uuid
      `;

      ok.mockClear();
      await service.publishPendingEvents(ok);

      expect(ok).toHaveBeenCalledTimes(1);
      const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
      expect(event.status).toBe(OutboxStatus.PUBLISHED);
    });

    it('does not reclaim an event whose lease is still fresh', async () => {
      const id = await service.addStandalone({ eventType: 'event.inflight', payload: {} });
      await prisma.$executeRaw`
        UPDATE outbox_events
        SET status = 'PROCESSING'::"OutboxStatus", processing_started_at = NOW()
        WHERE id = ${id}::uuid
      `;

      ok.mockClear();
      await service.publishPendingEvents(ok);

      expect(ok).not.toHaveBeenCalled();
    });

    it('two publishers running at once never publish the same event twice', async () => {
      for (let n = 0; n < 30; n++) {
        await service.addStandalone({ eventType: 'event.bulk', payload: { n } });
      }
      const seen: string[] = [];
      const publish = async (event: OutboxEventRow) => {
        seen.push(event.id);
      };

      await Promise.all([
        service.publishPendingEvents(publish),
        service.publishPendingEvents(publish),
        service.publishPendingEvents(publish),
      ]);

      expect(seen).toHaveLength(30);
      expect(new Set(seen).size).toBe(30);
    });
  });

  describe('startPublisher()', () => {
    it('polls and publishes new events until stopped', async () => {
      const id = await service.addStandalone({ eventType: 'event.polled', payload: {} });
      const publish = vi.fn(async (_event: OutboxEventRow) => undefined);

      service.startPublisher(publish);

      await vi.waitFor(
        async () => {
          const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
          expect(event.status).toBe(OutboxStatus.PUBLISHED);
        },
        { timeout: 5000, interval: 100 },
      );

      service.stopPublisher();
      expect(publish).toHaveBeenCalledTimes(1);
    });
  });

  describe('dead letters', () => {
    it('resets a dead-lettered event to PENDING', async () => {
      const id = await service.addStandalone({ eventType: 'event.dead', payload: {} });
      await prisma.$executeRaw`
        UPDATE outbox_events SET status = 'DEAD_LETTERED'::"OutboxStatus", attempts = 10, last_error = 'x'
        WHERE id = ${id}::uuid
      `;

      await service.retryDeadLettered(id);

      const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
      expect(event.status).toBe(OutboxStatus.PENDING);
      expect(event.attempts).toBe(0);
      expect(event.lastError).toBeNull();
    });

    it('lists dead-lettered events', async () => {
      const id = await service.addStandalone({ eventType: 'event.dead', payload: {} });
      await service.addStandalone({ eventType: 'event.alive', payload: {} });
      await prisma.$executeRaw`
        UPDATE outbox_events SET status = 'DEAD_LETTERED'::"OutboxStatus", last_error = 'boom'
        WHERE id = ${id}::uuid
      `;

      const dead = await service.getDeadLettered();

      expect(dead).toHaveLength(1);
      expect(dead[0].id).toBe(id);
      expect(dead[0].lastError).toBe('boom');
    });
  });
});

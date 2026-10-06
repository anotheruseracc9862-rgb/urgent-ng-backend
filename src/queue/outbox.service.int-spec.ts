/**
 * Outbox service integration tests (P1-04)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../database/database.module.js';
import { OutboxService, OutboxEventBatch } from './outbox.service.js';
import { getTestPrisma, cleanDatabase } from '../test/database.helper.js';
import { OutboxStatus } from '@prisma/client';

describe('OutboxService (Integration)', () => {
  let service: OutboxService;
  let module: TestingModule;
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();

    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [OutboxService],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  afterEach(async () => {
    service.stopPublisher();
    await module?.close();
  });

  describe('add()', () => {
    it('should add outbox event within a transaction', async () => {
      const eventId = await prisma.$transaction(async (tx) => {
        return service.add(tx, {
          eventType: 'user.created',
          aggregateType: 'User',
          aggregateId: '00000000-0000-0000-0000-000000000001',
          payload: { userId: '00000000-0000-0000-0000-000000000001', email: 'test@example.com' },
        });
      });

      expect(eventId).toBeDefined();

      const event = await prisma.outboxEvent.findUnique({
        where: { id: eventId },
      });

      expect(event).toBeDefined();
      expect(event?.eventType).toBe('user.created');
      expect(event?.aggregateType).toBe('User');
      expect(event?.status).toBe(OutboxStatus.PENDING);
      expect(event?.attempts).toBe(0);
    });

    it('should roll back outbox event if transaction fails', async () => {
      try {
        await prisma.$transaction(async (tx) => {
          await service.add(tx, {
            eventType: 'test.event',
            payload: { test: 'data' },
          });

          throw new Error('Transaction failed');
        });
      } catch (error) {
        // Expected
      }

      const events = await prisma.outboxEvent.findMany();
      expect(events).toHaveLength(0);
    });

    it('should support delayed events', async () => {
      const eventId = await prisma.$transaction(async (tx) => {
        return service.add(tx, {
          eventType: 'delayed.event',
          payload: { test: 'data' },
          delayMs: 5000, // 5 seconds
        });
      });

      const event = await prisma.outboxEvent.findUnique({
        where: { id: eventId },
      });

      expect(event?.availableAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('addStandalone()', () => {
    it('should add event outside of transaction', async () => {
      const eventId = await service.addStandalone({
        eventType: 'test.event',
        payload: { test: 'data' },
      });

      const event = await prisma.outboxEvent.findUnique({
        where: { id: eventId },
      });

      expect(event).toBeDefined();
      expect(event?.eventType).toBe('test.event');
    });
  });

  describe('publisher', () => {
    it('should publish pending events', async () => {
      // Create pending events
      await service.addStandalone({
        eventType: 'event.one',
        payload: { order: 1 },
      });

      await service.addStandalone({
        eventType: 'event.two',
        payload: { order: 2 },
      });

      // Mock publish function
      const publishedEvents: OutboxEventBatch[] = [];
      const publishFn = vi.fn(async (events: OutboxEventBatch[]) => {
        publishedEvents.push(...events);
      });

      // Start publisher (will run immediately)
      service.startPublisher(publishFn);

      // Wait for publisher to process
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(publishFn).toHaveBeenCalled();
      expect(publishedEvents).toHaveLength(2);
      expect(publishedEvents[0].eventType).toBe('event.one');
      expect(publishedEvents[1].eventType).toBe('event.two');

      // Check events are marked as published
      const events = await prisma.outboxEvent.findMany({
        orderBy: { occurredAt: 'asc' },
      });

      expect(events[0].status).toBe(OutboxStatus.PUBLISHED);
      expect(events[1].status).toBe(OutboxStatus.PUBLISHED);
      expect(events[0].processedAt).toBeDefined();
      expect(events[1].processedAt).toBeDefined();
    });

    it('should handle failed events with exponential backoff', async () => {
      await service.addStandalone({
        eventType: 'failing.event',
        payload: { test: 'data' },
      });

      // Publish function that always fails
      const publishFn = vi.fn(async () => {
        throw new Error('Publish failed');
      });

      service.startPublisher(publishFn);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const event = await prisma.outboxEvent.findFirst();
      expect(event?.status).toBe(OutboxStatus.FAILED);
      expect(event?.attempts).toBe(1);
      expect(event?.lastError).toContain('Publish failed');
      expect(event?.availableAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('should dead-letter events after 10 attempts', async () => {
      // Create event with 9 attempts already
      const eventId = await service.addStandalone({
        eventType: 'dead.letter.test',
        payload: { test: 'data' },
      });

      await prisma.outboxEvent.update({
        where: { id: eventId },
        data: { attempts: 9 },
      });

      const publishFn = vi.fn(async () => {
        throw new Error('Always fails');
      });

      service.startPublisher(publishFn);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const event = await prisma.outboxEvent.findFirst();
      expect(event?.status).toBe(OutboxStatus.DEAD_LETTERED);
      expect(event?.attempts).toBe(10);
    });

    it('should skip events not yet available', async () => {
      // Create event available in the future
      await service.addStandalone({
        eventType: 'future.event',
        payload: { test: 'data' },
        delayMs: 60000, // 1 minute
      });

      const publishFn = vi.fn();
      service.startPublisher(publishFn);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(publishFn).not.toHaveBeenCalled();

      const event = await prisma.outboxEvent.findFirst();
      expect(event?.status).toBe(OutboxStatus.PENDING);
    });

    it('should use SKIP LOCKED to prevent duplicate processing', async () => {
      // Create many events
      for (let i = 0; i < 10; i++) {
        await service.addStandalone({
          eventType: `event.${i}`,
          payload: { index: i },
        });
      }

      const publishedIds = new Set<string>();
      const publishFn = async (events: OutboxEventBatch[]) => {
        for (const event of events) {
          if (publishedIds.has(event.id)) {
            throw new Error(`Duplicate processing of event ${event.id}`);
          }
          publishedIds.add(event.id);
        }
      };

      service.startPublisher(publishFn);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(publishedIds.size).toBe(10);
    });
  });

  describe('retryDeadLettered()', () => {
    it('should reset dead-lettered event to pending', async () => {
      const eventId = await service.addStandalone({
        eventType: 'dead.letter',
        payload: { test: 'data' },
      });

      // Mark as dead-lettered
      await prisma.outboxEvent.update({
        where: { id: eventId },
        data: {
          status: OutboxStatus.DEAD_LETTERED,
          attempts: 10,
          lastError: 'Too many failures',
        },
      });

      await service.retryDeadLettered(eventId);

      const event = await prisma.outboxEvent.findUnique({
        where: { id: eventId },
      });

      expect(event?.status).toBe(OutboxStatus.PENDING);
      expect(event?.attempts).toBe(0);
      expect(event?.lastError).toBeNull();
    });
  });

  describe('getDeadLettered()', () => {
    it('should retrieve dead-lettered events', async () => {
      // Create mix of events
      const deadId1 = await service.addStandalone({
        eventType: 'dead.one',
        payload: { test: 'data' },
      });

      const deadId2 = await service.addStandalone({
        eventType: 'dead.two',
        payload: { test: 'data' },
      });

      await service.addStandalone({
        eventType: 'pending.event',
        payload: { test: 'data' },
      });

      // Mark two as dead-lettered
      await prisma.outboxEvent.update({
        where: { id: deadId1 },
        data: { status: OutboxStatus.DEAD_LETTERED, attempts: 10 },
      });

      await prisma.outboxEvent.update({
        where: { id: deadId2 },
        data: { status: OutboxStatus.DEAD_LETTERED, attempts: 10 },
      });

      const deadLettered = await service.getDeadLettered();

      expect(deadLettered).toHaveLength(2);
      expect(deadLettered[0].eventType).toMatch(/^dead\./);
      expect(deadLettered[1].eventType).toMatch(/^dead\./);
    });
  });
});

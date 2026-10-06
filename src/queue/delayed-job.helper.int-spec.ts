import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DelayedJobHelper } from './delayed-job.helper.js';
import { OutboxService } from './outbox.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { getTestPrisma, cleanDatabase } from '../test/database.helper.js';
import { testConfigModule } from '../test/test-modules.js';

describe('DelayedJobHelper (integration)', () => {
  let helper: DelayedJobHelper;
  let module: TestingModule;
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    module = await Test.createTestingModule({
      imports: [testConfigModule(), DatabaseModule],
      providers: [OutboxService, DelayedJobHelper],
    }).compile();
    helper = module.get(DelayedJobHelper);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('schedule', () => {
    it('schedules a delayed job in the outbox', async () => {
      const payload = { action: 'test', data: 'value' };
      const before = Date.now();

      await helper.schedule('test.delayed', payload, 5000);

      const events = await prisma.outboxEvent.findMany({ where: { eventType: 'test.delayed' } });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual(payload);
      expect(events[0].status).toBe('PENDING');

      // about 5 s ahead (allow a second of clock difference between host and database)
      const delay = events[0].availableAt.getTime() - before;
      expect(delay).toBeGreaterThan(4000);
      expect(delay).toBeLessThan(6500);
    });

    it('schedules with aggregate information', async () => {
      const aggregateId = '00000000-0000-0000-0000-0000000000e1';

      await helper.schedule('errand.pro-head-start', { errandId: aggregateId }, 300000, 'Errand', aggregateId);

      const [event] = await prisma.outboxEvent.findMany({
        where: { eventType: 'errand.pro-head-start' },
      });
      expect(event.aggregateType).toBe('Errand');
      expect(event.aggregateId).toBe(aggregateId);
    });
  });

  describe('scheduleAt', () => {
    it('schedules a job at a specific time', async () => {
      const runAt = new Date(Date.now() + 10_000);

      await helper.scheduleAt('test.scheduled', { message: 'hello' }, runAt);

      const [event] = await prisma.outboxEvent.findMany({ where: { eventType: 'test.scheduled' } });
      expect(Math.abs(event.availableAt.getTime() - runAt.getTime())).toBeLessThan(1500);
    });

    it('treats a time in the past as immediately due', async () => {
      await helper.scheduleAt('test.immediate', { urgent: true }, new Date(Date.now() - 1000));

      const [event] = await prisma.outboxEvent.findMany({ where: { eventType: 'test.immediate' } });
      const due = await prisma.$queryRaw<Array<{ due: boolean }>>`
        SELECT available_at <= NOW() + INTERVAL '1 second' AS due FROM outbox_events WHERE id = ${event.id}::uuid
      `;
      expect(due[0].due).toBe(true);
    });
  });
});

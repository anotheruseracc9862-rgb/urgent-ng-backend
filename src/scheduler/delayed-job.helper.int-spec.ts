import { Test, TestingModule } from '@nestjs/testing';
import { DelayedJobHelper } from './delayed-job.helper.js';
import { QueueModule } from '../queue/queue.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { PrismaService } from '../database/prisma.service.js';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration.js';

describe('DelayedJobHelper (integration)', () => {
  let helper: DelayedJobHelper;
  let prisma: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
        }),
        DatabaseModule,
        QueueModule,
      ],
      providers: [DelayedJobHelper],
    }).compile();

    helper = module.get<DelayedJobHelper>(DelayedJobHelper);
    prisma = module.get<PrismaService>(PrismaService);
  });

  beforeEach(async () => {
    // Clean up outbox events
    await prisma.outboxEvent.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('schedule', () => {
    it('should schedule a delayed job', async () => {
      const eventType = 'test.delayed';
      const payload = { action: 'test', data: 'value' };
      const delayMs = 5000; // 5 seconds

      const beforeTime = new Date();
      await helper.schedule(eventType, payload, delayMs);
      const afterTime = new Date();

      // Verify event was created in outbox
      const events = await prisma.outboxEvent.findMany({
        where: { eventType },
      });

      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual(payload);
      expect(events[0].status).toBe('PENDING');

      // Verify scheduledFor is approximately now + delayMs
      const expectedTime = new Date(beforeTime.getTime() + delayMs);
      const actualTime = events[0].availableAt;
      
      expect(actualTime.getTime()).toBeGreaterThanOrEqual(expectedTime.getTime());
      expect(actualTime.getTime()).toBeLessThan(afterTime.getTime() + delayMs + 100);
    });

    it('should schedule with aggregate information', async () => {
      const eventType = 'errand.pro-head-start';
      const payload = { errandId: 'e123' };
      const delayMs = 300000; // 5 minutes
      const aggregateType = 'Errand';
      const aggregateId = 'e123';

      await helper.schedule(
        eventType,
        payload,
        delayMs,
        aggregateType,
        aggregateId,
      );

      const events = await prisma.outboxEvent.findMany({
        where: { eventType },
      });

      expect(events).toHaveLength(1);
      expect(events[0].aggregateType).toBe(aggregateType);
      expect(events[0].aggregateId).toBe(aggregateId);
    });
  });

  describe('scheduleAt', () => {
    it('should schedule a job at a specific time', async () => {
      const eventType = 'test.scheduled';
      const payload = { message: 'hello' };
      const runAt = new Date(Date.now() + 10000); // 10 seconds from now

      await helper.scheduleAt(eventType, payload, runAt);

      const events = await prisma.outboxEvent.findMany({
        where: { eventType },
      });

      expect(events).toHaveLength(1);
      expect(events[0].availableAt).toEqual(runAt);
    });

    it('should schedule immediate execution with scheduledFor in the past', async () => {
      const eventType = 'test.immediate';
      const payload = { urgent: true };
      const runAt = new Date(Date.now() - 1000); // 1 second ago

      await helper.scheduleAt(eventType, payload, runAt);

      const events = await prisma.outboxEvent.findMany({
        where: { eventType },
      });

      expect(events).toHaveLength(1);
      expect(events[0].availableAt.getTime()).toBeLessThan(Date.now());
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { BaseSweeper } from './base-sweeper.js';
import { DatabaseModule } from '../database/database.module.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '@prisma/client';

/**
 * Test sweeper that processes idempotency keys as due rows.
 * This demonstrates the sweeper pattern with FOR UPDATE SKIP LOCKED.
 */
class TestSweeper extends BaseSweeper {
  public processedIds: string[] = [];

  constructor(prisma: PrismaService) {
    super(prisma, 'TestSweeper');
  }

  protected async processBatch(): Promise<number> {
    // Query for "due" idempotency keys (created more than 1 second ago)
    const dueRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM idempotency_keys
      WHERE created_at <= now() - interval '1 second'
        AND response_status IS NULL
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    `;

    for (const row of dueRows) {
      await this.processOne(row.id);
    }

    return dueRows.length;
  }

  private async processOne(id: string): Promise<void> {
    // Mark as processed by setting response_status
    await this.prisma.idempotencyKey.update({
      where: { id },
      data: { responseStatus: 200 },
    });

    this.processedIds.push(id);
  }
}

describe('BaseSweeper (integration)', () => {
  let prisma: PrismaService;
  let sweeper: TestSweeper;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();

    prisma = module.get<PrismaService>(PrismaService);
    sweeper = new TestSweeper(prisma);
  });

  beforeEach(async () => {
    // Clean up test data
    await prisma.idempotencyKey.deleteMany({});
    sweeper.processedIds = [];
  });

  afterAll(async () => {
    sweeper.stop();
    await prisma.$disconnect();
  });

  describe('manual sweep', () => {
    it('should process due rows', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const createdAt = new Date(Date.now() - 2000); // 2 seconds ago

      // Create a "due" row
      const row1 = await prisma.idempotencyKey.create({
        data: {
          userId,
          operation: 'test-op',
          key: 'key-1',
          requestHash: 'hash1',
          responseStatus: null,
          responseBody: Prisma.DbNull,
          createdAt,
        },
      });

      // Process one batch manually
      const processed = await sweeper['processBatch']();

      expect(processed).toBe(1);
      expect(sweeper.processedIds).toEqual([row1.id]);

      // Verify row was updated
      const updated = await prisma.idempotencyKey.findUnique({
        where: { id: row1.id },
      });
      expect(updated!.responseStatus).toBe(200);
    });

    it('should skip rows already processed', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const createdAt = new Date(Date.now() - 2000);

      // Create a processed row (has responseStatus)
      await prisma.idempotencyKey.create({
        data: {
          userId,
          operation: 'test-op',
          key: 'key-1',
          requestHash: 'hash1',
          responseStatus: 200,
          responseBody: Prisma.DbNull,
          createdAt,
        },
      });

      const processed = await sweeper['processBatch']();

      expect(processed).toBe(0);
      expect(sweeper.processedIds).toEqual([]);
    });

    it('should skip recent rows not yet due', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const createdAt = new Date(); // Just now

      await prisma.idempotencyKey.create({
        data: {
          userId,
          operation: 'test-op',
          key: 'key-1',
          requestHash: 'hash1',
          responseStatus: null,
          responseBody: Prisma.DbNull,
          createdAt,
        },
      });

      const processed = await sweeper['processBatch']();

      expect(processed).toBe(0);
    });

    it('should use FOR UPDATE SKIP LOCKED to avoid double-processing', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const createdAt = new Date(Date.now() - 2000);

      // Create two due rows
      const row1 = await prisma.idempotencyKey.create({
        data: {
          userId,
          operation: 'test-op',
          key: 'key-1',
          requestHash: 'hash1',
          responseStatus: null,
          responseBody: Prisma.DbNull,
          createdAt,
        },
      });

      const row2 = await prisma.idempotencyKey.create({
        data: {
          userId,
          operation: 'test-op',
          key: 'key-2',
          requestHash: 'hash2',
          responseStatus: null,
          responseBody: Prisma.DbNull,
          createdAt,
        },
      });

      // Create a second sweeper instance
      const sweeper2 = new TestSweeper(prisma);

      // Run both sweepers concurrently in a transaction context
      // Sweeper 1 locks row1, sweeper 2 should skip it
      await prisma.$transaction(async (tx) => {
        // Lock row1 for update
        await tx.$queryRaw`
          SELECT id FROM idempotency_keys
          WHERE id = ${row1.id}
          FOR UPDATE
        `;

        // Sweeper 2 runs and should only get row2 (row1 is locked)
        const processed2 = await sweeper2['processBatch']();
        expect(processed2).toBe(1);
        expect(sweeper2.processedIds).toEqual([row2.id]);
      });

      // After transaction, sweeper 1 can process row1
      const processed1 = await sweeper['processBatch']();
      expect(processed1).toBe(1);
      expect(sweeper.processedIds).toEqual([row1.id]);
    });
  });

  describe('start and stop', () => {
    it('should start and stop without error', () => {
      expect(() => {
        sweeper.start();
        sweeper.stop();
      }).not.toThrow();
    });

    it('should not start twice', () => {
      sweeper.start();
      const logSpy = jest.spyOn(sweeper['logger'], 'warn');
      sweeper.start();
      expect(logSpy).toHaveBeenCalledWith('Sweeper already running');
      sweeper.stop();
    });

    it('should process rows on interval', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const createdAt = new Date(Date.now() - 2000);

      // Create a due row
      await prisma.idempotencyKey.create({
        data: {
          userId,
          operation: 'test-op',
          key: 'key-1',
          requestHash: 'hash1',
          responseStatus: null,
          responseBody: Prisma.DbNull,
          createdAt,
        },
      });

      // Start sweeper and wait for it to process
      sweeper.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      sweeper.stop();

      // Verify row was processed
      expect(sweeper.processedIds.length).toBeGreaterThan(0);
    });
  });
});

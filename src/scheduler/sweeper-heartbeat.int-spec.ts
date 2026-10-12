import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { BaseSweeper } from './base-sweeper.js';
import { DatabaseModule } from '../database/database.module.js';
import { PrismaService } from '../database/prisma.service.js';
import { cleanDatabase } from '../test/database.helper.js';
import { testConfigModule } from '../test/test-modules.js';

class CountingSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    name: string,
    private readonly result: number | Error,
  ) {
    super(prisma, name);
  }

  protected processBatch(): Promise<number> {
    return this.result instanceof Error ? Promise.reject(this.result) : Promise.resolve(this.result);
  }
}

/** A sweeper leaves a heartbeat the admin console reads (Phase 11, operations). */
describe('Sweeper heartbeat', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({ imports: [testConfigModule(), DatabaseModule] }).compile();
    prisma = module.get(PrismaService);
    await cleanDatabase();
    await prisma.$executeRaw`DELETE FROM sweeper_runs`.catch(() => undefined);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const waitFor = async (name: string) => {
    for (let i = 0; i < 50; i += 1) {
      const row = await prisma.sweeperRun.findUnique({ where: { name } });
      if (row?.lastFinishedAt) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`No heartbeat for ${name}`);
  };

  it('records a finished sweep with what it processed', async () => {
    const sweeper = new CountingSweeper(prisma, 'HeartbeatOkSweeper', 3);
    sweeper.start();
    const row = await waitFor('HeartbeatOkSweeper');
    sweeper.stop();

    expect(row).toMatchObject({ lastProcessed: 3, lastError: null, failures: 0n });
    expect(Number(row.runs)).toBeGreaterThanOrEqual(1);
  });

  it('records a failed sweep with its error, and keeps the sweeper alive', async () => {
    const sweeper = new CountingSweeper(prisma, 'HeartbeatFailSweeper', new Error('boom'));
    sweeper.start();
    const row = await waitFor('HeartbeatFailSweeper');
    sweeper.stop();

    expect(row.lastError).toBe('boom');
    expect(Number(row.failures)).toBeGreaterThanOrEqual(1);
    expect(row.lastErrorAt).not.toBeNull();
  });
});

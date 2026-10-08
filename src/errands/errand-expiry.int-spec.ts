import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { insertErrand, seedCategories } from '../test/errand.helper.js';
import { ErrandExpiryService } from './errand-expiry.service.js';
import { ErrandExpirySweeper } from '../scheduler/errand-expiry.sweeper.js';
import { SchedulerModule } from '../scheduler/scheduler.module.js';
import { SweeperRegistry } from '../scheduler/sweeper.registry.js';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module.js';
import { computeExpiresAt, isScheduleInRange } from './errand-expiry.js';

process.env.RATE_LIMIT_DISABLED = 'true';

const config = { expiryHours: 24, scheduledBufferMinutes: 30, scheduledMaxOpenDays: 7 };

describe('computeExpiresAt (Backend PRD 11.4)', () => {
  const published = new Date('2026-10-10T08:00:00.000Z');

  it('ASAP: published time plus the configured hours', () => {
    expect(computeExpiresAt('ASAP', null, published, config).toISOString()).toBe('2026-10-11T08:00:00.000Z');
    expect(computeExpiresAt('ASAP', null, published, { ...config, expiryHours: 6 }).toISOString()).toBe('2026-10-10T14:00:00.000Z');
  });

  it('SCHEDULED: 30 minutes before the start', () => {
    const start = new Date('2026-10-10T20:00:00.000Z');
    expect(computeExpiresAt('SCHEDULED', start, published, config).toISOString()).toBe('2026-10-10T19:30:00.000Z');
  });

  it('SCHEDULED: never open longer than the maximum', () => {
    const start = new Date('2026-10-20T20:00:00.000Z');
    expect(computeExpiresAt('SCHEDULED', start, published, config).toISOString()).toBe('2026-10-17T08:00:00.000Z');
  });

  it('SCHEDULED without a time is a programming error', () => {
    expect(() => computeExpiresAt('SCHEDULED', null, published, config)).toThrow();
  });
});

describe('isScheduleInRange', () => {
  const now = new Date('2026-10-10T08:00:00.000Z');
  const bounds = { minLeadHours: 1, maxDaysAhead: 7 };
  const at = (ms: number) => new Date(now.getTime() + ms);

  it('accepts exactly 1 hour and exactly 7 days, and nothing outside', () => {
    expect(isScheduleInRange(at(3_600_000), now, bounds)).toBe(true);
    expect(isScheduleInRange(at(3_600_000 - 1), now, bounds)).toBe(false);
    expect(isScheduleInRange(at(7 * 86_400_000), now, bounds)).toBe(true);
    expect(isScheduleInRange(at(7 * 86_400_000 + 1), now, bounds)).toBe(false);
    expect(isScheduleInRange(at(-60_000), now, bounds)).toBe(false);
  });
});

describe('Errand expiry (P5-06)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categoryId: string;
  let user: Awaited<ReturnType<typeof signedInUser>>;
  const expiry = () => app.get(ErrandExpiryService);
  const status = async (id: string) => (await prisma.errand.findUniqueOrThrow({ where: { id } })).status;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categoryId = (await seedCategories()).delivery;
    user = await signedInUser(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('expires an errand exactly when its deadline passes on the database clock, and not before', async () => {
    const id = await insertErrand({ requesterId: user.userId, categoryId });
    await prisma.$executeRaw`UPDATE errands SET expires_at = clock_timestamp() + interval '1500 milliseconds' WHERE id = ${id}::uuid`;

    expect(await expiry().expireDue()).toBe(0);
    expect(await status(id)).toBe('OPEN');

    await sleep(1700);
    expect(await expiry().expireDue()).toBe(1);
    expect(await status(id)).toBe('EXPIRED');
  });

  it('writes the history row, the audit row and the errand.expired event with the change', async () => {
    const id = await insertErrand({ requesterId: user.userId, categoryId, expiresInHours: -1 });

    expect(await expiry().expireDue()).toBe(1);

    const history = await prisma.$queryRaw<Array<{ f: string; t: string; a: string }>>`SELECT from_status::text AS f, to_status::text AS t, actor_type::text AS a FROM errand_status_history WHERE errand_id = ${id}::uuid`;
    expect(history).toEqual([{ f: 'OPEN', t: 'EXPIRED', a: 'SYSTEM' }]);
    const events = await prisma.$queryRaw<Array<{ event_type: string; payload: Record<string, unknown> }>>`SELECT event_type, payload FROM outbox_events WHERE aggregate_id = ${id}::uuid`;
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('errand.expired');
    expect(events[0].payload).toMatchObject({ errandId: id, requesterId: user.userId, from: 'OPEN', to: 'EXPIRED' });
  });

  it('leaves everything that is not an open, overdue errand alone', async () => {
    const live = await insertErrand({ requesterId: user.userId, categoryId, expiresInHours: 5 });
    const selected = await insertErrand({ requesterId: user.userId, categoryId, status: 'RUNNER_SELECTED', expiresInHours: -2 });
    const accepted = await insertErrand({ requesterId: user.userId, categoryId, status: 'ACCEPTED', expiresInHours: -2 });
    const draft = await insertErrand({ requesterId: user.userId, categoryId, status: 'DRAFT' });
    const done = await insertErrand({ requesterId: user.userId, categoryId, status: 'COMPLETED', expiresInHours: -2 });

    expect(await expiry().expireDue()).toBe(0);

    expect(await status(live)).toBe('OPEN');
    expect(await status(selected)).toBe('RUNNER_SELECTED');
    expect(await status(accepted)).toBe('ACCEPTED');
    expect(await status(draft)).toBe('DRAFT');
    expect(await status(done)).toBe('COMPLETED');
  });

  it('expires many due errands in batches and is safe to run twice at once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      ids.push(await insertErrand({ requesterId: user.userId, categoryId, expiresInHours: -1 }));
    }

    const [a, b] = await Promise.all([expiry().expireDue(), expiry().expireDue()]);

    expect(a + b).toBe(12);
    for (const id of ids) expect(await status(id)).toBe('EXPIRED');
    const events = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'errand.expired'`;
    expect(events[0].n).toBe(12);
  });

  it('respects an extension: the new deadline is the one that counts', async () => {
    const id = await insertErrand({ requesterId: user.userId, categoryId, expiresInHours: -1 });
    await prisma.$executeRaw`UPDATE errands SET expires_at = now() + interval '3 hours', extended_at = now() WHERE id = ${id}::uuid`;
    expect(await expiry().expireDue()).toBe(0);
    expect(await status(id)).toBe('OPEN');
  });

  it('is applied lazily when the requester reads an overdue errand', async () => {
    const id = await insertErrand({ requesterId: user.userId, categoryId, expiresInHours: -1 });

    const res = await request(app.getHttpServer()).get(`${API}/errands/${id}`).set(...bearer(user.accessToken)).expect(200);

    expect(res.body.data.status).toBe('EXPIRED');
    expect(await status(id)).toBe('EXPIRED');
  });

  it('does not expire an errand whose requester selected a runner at the last moment', async () => {
    const id = await insertErrand({ requesterId: user.userId, categoryId, expiresInHours: -1 });
    await prisma.$executeRaw`UPDATE errands SET status = 'RUNNER_SELECTED'::"ErrandStatus" WHERE id = ${id}::uuid`;
    expect(await expiry().expireIfDue(id)).toBe(false);
    expect(await status(id)).toBe('RUNNER_SELECTED');
  });

  it('is part of the scheduler: the sweeper is registered and runs the same service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, SchedulerModule] }).compile();
    try {
      expect(moduleRef.get(ErrandExpirySweeper)).toBeInstanceOf(ErrandExpirySweeper);
      expect(moduleRef.get(SweeperRegistry)).toBeDefined();
      const id = await insertErrand({ requesterId: user.userId, categoryId, expiresInHours: -1 });
      expect(await moduleRef.get(ErrandExpirySweeper)['processBatch']()).toBe(1);
      expect(await status(id)).toBe('EXPIRED');
    } finally {
      await moduleRef.close();
    }
  });
});

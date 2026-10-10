/**
 * P6-01 / P6-02 integration tests: the daily offer counter under concurrency, Lagos day roll-over,
 * the limit endpoint and live config changes. Real PostgreSQL and Redis.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { readyRunner } from '../test/verification.helper.js';
import { insertErrand, seedCategories } from '../test/errand.helper.js';
import { submitOffer } from '../test/offer.helper.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { ClockService } from '../common/utils/time.service.js';
import { OfferLimitService } from './offer-limit.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { PrismaService } from '../database/prisma.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Offer daily limit (P6-01, P6-02)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categoryId: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categoryId = (await seedCategories()).delivery;
  });
  afterAll(async () => {
    await app.close();
  });

  const used = async (userId: string) => (await prisma.offerDailyCounter.findMany({ where: { userId } })).reduce((n, c) => n + c.count, 0);

  it('parallel submits never create more offers than the limit, and the counter equals the offers', async () => {
    const requester = await signedInUser(app);
    const runner = await readyRunner(app);
    await app.get(BusinessConfigService).set('MAX_OPEN_OFFERS_PER_RUNNER', 100);
    const errands = await Promise.all(Array.from({ length: 25 }, () => insertErrand({ requesterId: requester.userId, categoryId })));

    const results = await Promise.all(errands.map((id) => submitOffer(app, runner, id)));

    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status !== 201);
    expect(created).toHaveLength(10);
    expect(refused.every((r) => r.status === 429 && r.body.error.code === 'OFFER_DAILY_LIMIT_REACHED')).toBe(true);
    expect(refused[0].body.error.details.resetsAt).toBeTruthy();
    expect(await prisma.offer.count({ where: { runnerId: runner.userId } })).toBe(10);
    expect(await used(runner.userId)).toBe(10);
  });

  it('a failed submit does not spend the allowance', async () => {
    const requester = await signedInUser(app);
    const runner = await readyRunner(app);
    const errandId = await insertErrand({ requesterId: requester.userId, categoryId, expiresInHours: -1 });

    expect((await submitOffer(app, runner, errandId)).status).toBe(409);

    expect(await used(runner.userId)).toBe(0);
  });

  it('GET /runner/offer-limit reports used, remaining and resetsAt, and follows a config change at once', async () => {
    const requester = await signedInUser(app);
    const runner = await readyRunner(app);
    for (let i = 0; i < 3; i += 1) {
      await submitOffer(app, runner, await insertErrand({ requesterId: requester.userId, categoryId })).expect(201);
    }
    const read = () => request(app.getHttpServer()).get(`${API}/runner/offer-limit`).set(...bearer(runner.accessToken)).expect(200);

    const before = (await read()).body.data;
    expect(before).toMatchObject({ used: 3, limit: 10, remaining: 7, isPro: false });
    expect(new Date(before.resetsAt).getTime()).toBeGreaterThan(Date.now());

    await app.get(BusinessConfigService).set('FREE_RUNNER_DAILY_OFFER_LIMIT', 5);
    expect((await read()).body.data).toMatchObject({ used: 3, limit: 5, remaining: 2 });
  });

  it('rolls over at midnight Africa/Lagos', async () => {
    const runner = await signedInUser(app);
    const clock = { current: new Date('2026-03-10T22:59:59.000Z'), now() { return this.current; } };
    const real = new ClockService();
    const service = new OfferLimitService(
      app.get(BusinessConfigService),
      Object.assign(Object.create(real), { now: () => clock.current }) as ClockService,
      app.get(PrismaService),
    );

    const spend = () => prisma.$transaction((tx) => service.reserve(tx, runner.userId));
    await spend();
    await spend();
    expect((await service.getLimitStatus(runner.userId)).used).toBe(2);

    clock.current = new Date('2026-03-10T23:00:01.000Z'); // 00:00:01 in Lagos (UTC+1)
    expect((await service.getLimitStatus(runner.userId)).used).toBe(0);
    await spend();
    const rows = await prisma.offerDailyCounter.findMany({ where: { userId: runner.userId }, orderBy: { dayLagos: 'asc' } });
    expect(rows.map((r) => [r.dayLagos, r.count])).toEqual([
      ['2026-03-10', 2],
      ['2026-03-11', 1],
    ]);
  });

  it('reserve throws OFFER_DAILY_LIMIT_REACHED with resetsAt and leaves the count at the limit', async () => {
    const runner = await signedInUser(app);
    const service = app.get(OfferLimitService);
    await app.get(BusinessConfigService).set('FREE_RUNNER_DAILY_OFFER_LIMIT', 2);
    await prisma.$transaction((tx) => service.reserve(tx, runner.userId));
    await prisma.$transaction((tx) => service.reserve(tx, runner.userId));

    const error = await prisma.$transaction((tx) => service.reserve(tx, runner.userId)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).getCode()).toBe('OFFER_DAILY_LIMIT_REACHED');
    expect((error as DomainException).getDetails()).toMatchObject({ used: 2, limit: 2, remaining: 0 });
    expect(await used(runner.userId)).toBe(2);
  });
});

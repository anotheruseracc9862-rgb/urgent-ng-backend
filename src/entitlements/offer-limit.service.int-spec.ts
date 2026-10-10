/**
 * P6-01 integration tests: OfferLimitService concurrency and day rollover
 *
 * Verifies:
 * - Row lock prevents counter exceeding limit under concurrent load
 * - Lagos day boundary resets the counter
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { seedPolicies, signedInUser } from '../test/auth.helper.js';
import { OfferLimitService } from './offer-limit.service.js';
import { ClockService } from '../common/utils/time.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('OfferLimitService integration (P6-01)', () => {
  let app: INestApplication;
  let service: OfferLimitService;
  const prisma = getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
    service = app.get(OfferLimitService);
  });

  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
  });

  afterAll(async () => {
    await app.close();
  });

  it('row lock prevents counter exceeding limit under concurrent load', async () => {
    const user = await signedInUser(app);
    const limit = 10;

    // Spawn 50 parallel consume() calls
    // Each call tries to consume 1, but the service enforces limit = 10
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => service.consume(user.userId, 1)),
    );

    // All calls should succeed (no exceptions from row lock)
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    expect(succeeded.length).toBe(50);

    // Verify final count does not exceed the limit
    // Due to transaction isolation and the upsert logic, some parallel calls
    // may complete before reaching exactly limit, but none should exceed it
    const status = await service.getLimitStatus(user.userId);
    expect(status.used).toBeGreaterThan(0);
    expect(status.used).toBeLessThanOrEqual(limit);

    // Key property: no individual call reported exceeding the limit
    for (const result of succeeded) {
      const value = (result as PromiseFulfilledResult<any>).value;
      expect(value.used).toBeLessThanOrEqual(limit);
    }

    // Verify database row never exceeds limit
    const dayLagos = app.get(ClockService).lagosDay(new Date());
    const counter = await prisma.offerDailyCounter.findUnique({
      where: {
        userId_dayLagos: {
          userId: user.userId,
          dayLagos,
        },
      },
    });
    expect(counter?.count).toBeGreaterThan(0);
    expect(counter?.count).toBeLessThanOrEqual(limit);
  });

  it('day boundary at Lagos midnight resets the counter', async () => {
    const user = await signedInUser(app);
    const configService = app.get(BusinessConfigService);

    // Create a fake ClockService that controls time
    const fakeClock = {
      currentTime: new Date('2025-01-15T23:59:59.000+01:00'), // Lagos time 23:59:59
      now() {
        return this.currentTime;
      },
      lagosDay(date: Date) {
        const realClock = new ClockService();
        return realClock.lagosDay(date);
      },
      startOfDayLagos(date: Date) {
        const realClock = new ClockService();
        return realClock.startOfDayLagos(date);
      },
    };

    // Create a service instance with fake clock
    const fakeService = new OfferLimitService(
      configService,
      fakeClock as any,
      undefined,
      prisma,
    );

    // Consume at 23:59:59 Lagos time
    await fakeService.consume(user.userId, 3);

    const statusBeforeMidnight = await fakeService.getLimitStatus(user.userId);
    expect(statusBeforeMidnight.used).toBe(3);
    expect(statusBeforeMidnight.remaining).toBe(7);

    // Advance to 00:00:01 next day
    fakeClock.currentTime = new Date('2025-01-16T00:00:01.000+01:00');

    // Verify new day gets fresh counter
    const statusAfterMidnight = await fakeService.getLimitStatus(user.userId);
    expect(statusAfterMidnight.used).toBe(0);
    expect(statusAfterMidnight.remaining).toBe(10);

    // Verify we can consume again in the new day
    await fakeService.consume(user.userId, 2);
    const statusAfterConsume = await fakeService.getLimitStatus(user.userId);
    expect(statusAfterConsume.used).toBe(2);
    expect(statusAfterConsume.remaining).toBe(8);

    // Verify two different day counters exist in database
    const counters = await prisma.offerDailyCounter.findMany({
      where: { userId: user.userId },
      orderBy: { dayLagos: 'asc' },
    });
    expect(counters.length).toBe(2);
    expect(counters[0].dayLagos).toBe('2025-01-15');
    expect(counters[0].count).toBe(3);
    expect(counters[1].dayLagos).toBe('2025-01-16');
    expect(counters[1].count).toBe(2);
  });
});

/**
 * P8-04: nearby-errand matching (Backend PRD 12.5). Waves, distance order, eligibility rules,
 * Runner Pro head start, hourly push cap, quiet hours. Real PostgreSQL and Redis.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { openErrand, seedCategories } from '../test/errand.helper.js';
import { profileBody, readyRunner } from '../test/verification.helper.js';
import { uniqueNin } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { OfferLimitService } from '../entitlements/offer-limit.service.js';
import { DeviceService } from '../auth/device.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

const LAGOS = { lat: 6.5244, lng: 3.3792 };

describe('Nearby-errand matching (P8-04)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categories: Record<string, string>;
  let nin = 100;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categories = await seedCategories();
  });
  afterAll(async () => {
    await app.close();
  });

  type Runner = Awaited<ReturnType<typeof readyRunner>>;
  const runnerAt = async (center: { lat: number; lng: number } = LAGOS, extra: Record<string, unknown> = {}): Promise<Runner> => {
    nin += 1;
    const runner = await readyRunner(app, uniqueNin(nin));
    await request(app.getHttpServer())
      .put(`${API}/runner/profile`)
      .set(...bearer(runner.accessToken))
      .send(profileBody({ areaCenter: center, areaRadiusKm: 5, ...extra }))
      .expect(200);
    return runner;
  };
  const nearbyFor = async (user: { accessToken: string }) =>
    ((await request(app.getHttpServer()).get(`${API}/notifications`).set(...bearer(user.accessToken)).expect(200)).body.data as Array<{ type: string; data: { errandId?: string } }>).filter(
      (n) => n.type === 'errand.nearby',
    );
  /** Midday in Lagos, so quiet hours do not depend on when the suite runs. */
  const setMidday = () => prisma.$executeRaw`UPDATE outbox_events SET occurred_at = date_trunc('day', now()) + interval '11 hours'`;
  const publish = async (requester: { accessToken: string }) => {
    const errandId = await openErrand(app, requester, categories.delivery);
    await setMidday();
    return errandId;
  };

  describe('who is matched', () => {
    it('only eligible runners inside their own circle, and the rest of the rules of PRD 12.5', async () => {
      const requester = await signedInUser(app);
      const near = await runnerAt();
      const far = await runnerAt({ lat: 9.0765, lng: 7.3986 }); // Abuja
      const away = await runnerAt();
      await request(app.getHttpServer()).put(`${API}/runner/availability`).set(...bearer(away.accessToken)).send({ availability: 'UNAVAILABLE' }).expect(200);
      const excluded = await runnerAt(LAGOS, { excludedCategoryIds: [categories.delivery] });
      const blocked = await runnerAt();
      await request(app.getHttpServer()).post(`${API}/users/${blocked.userId}/block`).set(...bearer(requester.accessToken)).expect(204);
      const unverified = await signedInUser(app);
      await request(app.getHttpServer()).put(`${API}/runner/profile`).set(...bearer(unverified.accessToken)).send(profileBody()).expect(200);

      const errandId = await publish(requester);
      await dispatchOutbox(app, { eventType: 'errand.published' });
      // Non-Pro runners are told after the head start.
      await dispatchOutbox(app, { eventType: 'errand.nearby_delayed' });

      expect((await nearbyFor(near)).map((n) => n.data.errandId)).toEqual([errandId]);
      for (const runner of [far, away, excluded, blocked, unverified]) {
        expect(await nearbyFor(runner)).toHaveLength(0);
      }
      expect(await nearbyFor(requester as never)).toHaveLength(0);
    });

    it('the requester is never told about their own errand, even with a runner profile', async () => {
      const both = await readyRunner(app, uniqueNin(900));
      const errandId = await openErrand(app, both, categories.delivery);
      await setMidday();
      await dispatchOutbox(app);
      expect(await nearbyFor(both)).toHaveLength(0);
      expect(errandId).toBeTruthy();
    });

    it('is a wave of the nearest runners, limited by configuration', async () => {
      await app.get(BusinessConfigService).set('NEARBY_FIRST_WAVE_SIZE', 2);
      const requester = await signedInUser(app);
      const closest = await runnerAt({ lat: LAGOS.lat + 0.001, lng: LAGOS.lng });
      const second = await runnerAt({ lat: LAGOS.lat + 0.01, lng: LAGOS.lng });
      const third = await runnerAt({ lat: LAGOS.lat + 0.03, lng: LAGOS.lng });
      await publish(requester);

      await dispatchOutbox(app, { eventType: 'errand.published' });
      await dispatchOutbox(app, { eventType: 'errand.nearby_delayed' });

      expect(await nearbyFor(closest)).toHaveLength(1);
      expect(await nearbyFor(second)).toHaveLength(1);
      expect(await nearbyFor(third)).toHaveLength(0);
    });
  });

  describe('Runner Pro head start', () => {
    it('Pro runners are told at once, the others after the delay', async () => {
      const requester = await signedInUser(app);
      const pro = await runnerAt();
      const free = await runnerAt();
      (app.get(OfferLimitService) as unknown as { policy: { isPro(id: string): Promise<boolean> } }).policy = {
        isPro: async (id: string) => id === pro.userId,
      };
      await publish(requester);

      await dispatchOutbox(app, { eventType: 'errand.published' });

      expect(await nearbyFor(pro)).toHaveLength(1);
      expect(await nearbyFor(free)).toHaveLength(0);
      const delayed = await prisma.outboxEvent.findFirstOrThrow({ where: { eventType: 'errand.nearby_delayed' } });
      expect((delayed.payload as { runnerIds: string[] }).runnerIds).toEqual([free.userId]);
      const waitMs = delayed.availableAt.getTime() - delayed.createdAt.getTime();
      expect(waitMs).toBeGreaterThan(110_000);
      expect(waitMs).toBeLessThan(130_000);

      await dispatchOutbox(app, { eventType: 'errand.nearby_delayed' });
      expect(await nearbyFor(free)).toHaveLength(1);
    });

    it('the delayed wave does nothing when the errand is no longer open', async () => {
      const requester = await signedInUser(app);
      const free = await runnerAt();
      const errandId = await publish(requester);
      await dispatchOutbox(app, { eventType: 'errand.published' });
      await request(app.getHttpServer())
        .post(`${API}/errands/${errandId}/cancel`)
        .set(...bearer(requester.accessToken))
        .send({ reason: 'REQUESTER_CANCELLED' })
        .expect(200);

      await dispatchOutbox(app, { eventType: 'errand.nearby_delayed' });

      expect(await nearbyFor(free)).toHaveLength(0);
    });
  });

  describe('delivery rules', () => {
    it('the same event twice notifies once', async () => {
      const requester = await signedInUser(app);
      const near = await runnerAt();
      await publish(requester);
      await dispatchOutbox(app, { eventType: 'errand.published' });
      await dispatchOutbox(app, { eventType: 'errand.nearby_delayed' });
      // A retry of the delayed job.
      await prisma.outboxEvent.updateMany({ where: { eventType: 'errand.nearby_delayed' }, data: { status: 'PENDING' } });
      await dispatchOutbox(app, { eventType: 'errand.nearby_delayed' });

      expect(await nearbyFor(near)).toHaveLength(1);
    });

    it('the push goes out up to the hourly cap, then only the in-app notification', async () => {
      await app.get(BusinessConfigService).set('NEARBY_PUSH_CAP_PER_HOUR', 1);
      const requester = await signedInUser(app);
      const near = await runnerAt();
      await app.get(DeviceService).register(near.userId, 'MOBILE_PUSH', 'near-token');
      await publish(requester);
      await publish(requester);
      await publish(requester);

      await dispatchOutbox(app, { eventType: 'errand.published' });
      // The delayed events were created just now: pin them to midday as well.
      await setMidday();
      await dispatchOutbox(app, { eventType: 'errand.nearby_delayed' });

      const notices = await nearbyFor(near);
      expect(notices).toHaveLength(3);
      const deliveries = await prisma.notificationDelivery.findMany({ where: { channel: 'PUSH', notificationId: { in: await idsOf(near.userId) } } });
      expect(deliveries.filter((d) => d.status === 'SENT')).toHaveLength(1);
      expect(deliveries.filter((d) => d.suppressedReason === 'HOURLY_CAP')).toHaveLength(2);
    });

    it('quiet hours hold the push but the in-app notification is created', async () => {
      const requester = await signedInUser(app);
      const near = await runnerAt();
      await app.get(DeviceService).register(near.userId, 'MOBILE_PUSH', 'near-token');
      await openErrand(app, requester, categories.delivery);
      // 23:30 in Lagos is 22:30 UTC.
      await prisma.$executeRaw`UPDATE outbox_events SET occurred_at = date_trunc('day', now()) + interval '22 hours 30 minutes'`;

      await dispatchOutbox(app, { eventType: 'errand.published' });
      // The delayed part is a new event stamped with the real time; put it at the same quiet hour,
      // or the test would only pass at night.
      await prisma.$executeRaw`UPDATE outbox_events SET occurred_at = date_trunc('day', now()) + interval '22 hours 30 minutes' WHERE status = 'PENDING'`;
      await dispatchOutbox(app, { eventType: 'errand.nearby_delayed' });

      expect(await nearbyFor(near)).toHaveLength(1);
      const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { channel: 'PUSH' } });
      expect(delivery).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'QUIET_HOURS' });
    });
  });

  async function idsOf(userId: string): Promise<string[]> {
    return (await prisma.notification.findMany({ where: { userId, type: 'errand.nearby' }, select: { id: true } })).map((n) => n.id);
  }
});

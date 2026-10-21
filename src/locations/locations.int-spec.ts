/**
 * P9-07: runner location sharing and the live view (Backend PRD 17.3, 17.4, 17.6). HTTP, real
 * PostgreSQL and PostGIS.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { acceptedScene, executionStep, selectedScene } from '../test/assignment.helper.js';
import { MAPS_PROVIDER } from '../common/providers/maps.provider.js';
import type { FakeMapsProvider } from '../common/providers/fakes/maps.fake.js';
import { RunnerLocationService } from './runner-location.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Runner location (P9-07)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categoryId: string;
  let serviceId: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    const categories = await seedCategories();
    categoryId = categories.delivery;
    serviceId = categories.home_cleaning;
  });
  afterAll(async () => {
    await app.close();
  });

  type Authed = { accessToken: string; userId: string };
  const LAGOS = { lat: 6.5244, lng: 3.3792 };
  const consent = (user: Authed) =>
    request(app.getHttpServer()).post(`${API}/me/consents`).set(...bearer(user.accessToken)).send({ type: 'LOCATION_SHARING', version: '1.0' }).expect(200);
  const share = (user: Authed, assignmentId: string, body: Record<string, unknown> = LAGOS) =>
    request(app.getHttpServer()).post(`${API}/assignments/${assignmentId}/location`).set(...bearer(user.accessToken)).send(body);
  const live = (user: Authed, assignmentId: string) =>
    request(app.getHttpServer()).get(`${API}/assignments/${assignmentId}/location`).set(...bearer(user.accessToken));
  const sharing = (user: Authed, assignmentId: string, enabled: boolean) =>
    request(app.getHttpServer()).put(`${API}/assignments/${assignmentId}/location/sharing`).set(...bearer(user.accessToken)).send({ enabled });
  /** Make the last stored update look `seconds` old. */
  const age = (assignmentId: string, seconds: number) =>
    prisma.$executeRawUnsafe(
      `UPDATE location_records SET captured_at = now() - interval '${seconds} seconds', received_at = now() - interval '${seconds} seconds' WHERE assignment_id = $1::uuid`,
      assignmentId,
    );
  async function sharingRunner() {
    const s = await acceptedScene(app, categoryId);
    await consent(s.runner);
    return s;
  }

  describe('reporting', () => {
    it('needs the location-sharing consent', async () => {
      const s = await acceptedScene(app, categoryId);

      const res = await share(s.runner, s.assignmentId);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('LOCATION_PERMISSION_REQUIRED');
      expect(await prisma.locationRecord.count()).toBe(0);
    });

    it('stores an update and shows the requester a rounded point with its age', async () => {
      const s = await sharingRunner();

      const res = await share(s.runner, s.assignmentId, { ...LAGOS, accuracyMeters: 12.5 }).expect(200);
      expect(res.body.data).toEqual({ recorded: true, result: 'STORED' });

      const view = (await live(s.requester, s.assignmentId).expect(200)).body.data;
      expect(view).toMatchObject({ assignmentId: s.assignmentId, errandStatus: 'ACCEPTED', sharing: 'ACTIVE', freshness: 'FRESH' });
      expect(view.point).not.toBeNull();
      expect(view.point).not.toEqual(LAGOS);
      // Within one 250 m cell of the exact position.
      expect(Math.abs(view.point.lat - LAGOS.lat) * 111_320).toBeLessThan(260);
      expect(view.ageSeconds).toBeLessThan(30);
      // Exact coordinates are nowhere in the response.
      expect(JSON.stringify(view)).not.toContain(String(LAGOS.lat));
    });

    it('answers only to the runner of the assignment', async () => {
      const s = await sharingRunner();
      const stranger = await signedInUser(app);

      expect((await share(s.requester, s.assignmentId)).status).toBe(404);
      expect((await share(stranger, s.assignmentId)).status).toBe(404);
      expect((await live(stranger, s.assignmentId)).status).toBe(404);
      expect((await sharing(s.requester, s.assignmentId, false)).status).toBe(404);
    });

    it('is refused before acceptance and after the errand ends', async () => {
      const pending = await selectedScene(app, categoryId);
      await consent(pending.runner);
      expect((await share(pending.runner, pending.assignmentId)).status).toBe(409);
      expect((await live(pending.requester, pending.assignmentId)).status).toBe(404);

      const s = await sharingRunner();
      await request(app.getHttpServer())
        .post(`${API}/assignments/${s.assignmentId}/cancel`)
        .set(...bearer(s.requester.accessToken))
        .set('Idempotency-Key', 'cancel-key-0001')
        .send({ reason: 'REQUESTER_CANCELLED' })
        .expect(200);
      expect((await share(s.runner, s.assignmentId)).status).toBe(409);
      expect((await live(s.requester, s.assignmentId)).status).toBe(404);
    });

    it('limits updates to one per 30 seconds, with the wait', async () => {
      const s = await sharingRunner();
      await share(s.runner, s.assignmentId).expect(200);

      const res = await share(s.runner, s.assignmentId, { lat: 6.54, lng: 3.4 });

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(await prisma.locationRecord.count()).toBe(1);
    });

    it('does not store a position that has not moved, until it is time for a heartbeat', async () => {
      const s = await sharingRunner();
      await share(s.runner, s.assignmentId).expect(200);
      await age(s.assignmentId, 60);

      const still = await share(s.runner, s.assignmentId, { lat: LAGOS.lat + 0.0001, lng: LAGOS.lng }).expect(200);
      expect(still.body.data).toEqual({ recorded: false, result: 'NO_MOVEMENT' });
      expect(await prisma.locationRecord.count()).toBe(1);

      await age(s.assignmentId, 200);
      const heartbeat = await share(s.runner, s.assignmentId, { lat: LAGOS.lat + 0.0001, lng: LAGOS.lng }).expect(200);
      expect(heartbeat.body.data.recorded).toBe(true);

      await age(s.assignmentId, 60);
      const moved = await share(s.runner, s.assignmentId, { lat: LAGOS.lat + 0.01, lng: LAGOS.lng }).expect(200);
      expect(moved.body.data.recorded).toBe(true);
      expect(await prisma.locationRecord.count()).toBe(3);
    });

    it('never trusts the device clock', async () => {
      const s = await sharingRunner();

      await share(s.runner, s.assignmentId, { ...LAGOS, capturedAt: new Date(Date.now() + 3_600_000).toISOString() }).expect(200);

      const row = await prisma.locationRecord.findFirstOrThrow();
      // The stored time is the server's, never the device's: it is not later than the database clock now.
      const [{ now }] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      expect(row.capturedAt.getTime()).toBeLessThanOrEqual(now.getTime() + 1000);
      await age(s.assignmentId, 60);
      const old = await share(s.runner, s.assignmentId, { lat: 6.6, lng: 3.5, capturedAt: new Date(Date.now() - 3_600_000).toISOString() });
      expect(old.status).toBe(400);
    });

    it('raises an anomaly signal for an impossible jump, and still stores it', async () => {
      const s = await sharingRunner();
      await share(s.runner, s.assignmentId).expect(200);
      await age(s.assignmentId, 60);

      // About 600 km in a minute.
      await share(s.runner, s.assignmentId, { lat: 12.0, lng: 8.5 }).expect(200);

      const events = await prisma.outboxEvent.findMany({ where: { eventType: 'runner_location.anomaly' } });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ assignmentId: s.assignmentId, userId: s.runner.userId, signal: 'LOCATION_JUMP' });
      expect(await prisma.locationRecord.count()).toBe(2);
    });
  });

  describe('freshness and stopping', () => {
    it('labels a stale position and shows nothing once it is expired', async () => {
      const s = await sharingRunner();
      await share(s.runner, s.assignmentId).expect(200);

      await age(s.assignmentId, 10 * 60);
      const stale = (await live(s.requester, s.assignmentId).expect(200)).body.data;
      expect(stale.freshness).toBe('STALE');
      expect(stale.point).not.toBeNull();
      expect(stale.estimatedArrivalMinutes).toBeNull();

      await age(s.assignmentId, 40 * 60);
      const expired = (await live(s.requester, s.assignmentId).expect(200)).body.data;
      expect(expired).toMatchObject({ freshness: 'EXPIRED', point: null });
      expect(expired.capturedAt).not.toBeNull();
    });

    it('says nothing was shared when nothing was', async () => {
      const s = await sharingRunner();

      const view = (await live(s.requester, s.assignmentId).expect(200)).body.data;

      expect(view).toMatchObject({ freshness: 'NONE', point: null, capturedAt: null, ageSeconds: null, sharing: 'ACTIVE' });
    });

    it('the runner can stop sharing, which hides the position and refuses updates, and resume', async () => {
      const s = await sharingRunner();
      await share(s.runner, s.assignmentId).expect(200);

      expect((await sharing(s.runner, s.assignmentId, false).expect(200)).body.data).toEqual({ assignmentId: s.assignmentId, enabled: false });
      const hidden = (await live(s.requester, s.assignmentId).expect(200)).body.data;
      expect(hidden).toMatchObject({ sharing: 'STOPPED', point: null, capturedAt: null });
      const refused = await share(s.runner, s.assignmentId);
      expect(refused.status).toBe(409);
      expect(refused.body.error.details.reason).toBe('SHARING_STOPPED');

      await sharing(s.runner, s.assignmentId, true).expect(200);
      await age(s.assignmentId, 60);
      await share(s.runner, s.assignmentId, { lat: 6.6, lng: 3.5 }).expect(200);
      expect((await live(s.requester, s.assignmentId).expect(200)).body.data.sharing).toBe('ACTIVE');
    });

    it('works through the later steps of the errand', async () => {
      const s = await sharingRunner();
      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
      await executionStep(app, s.runner, s.assignmentId, 'pickup').expect(201);

      await share(s.runner, s.assignmentId).expect(200);

      expect((await live(s.requester, s.assignmentId).expect(200)).body.data.errandStatus).toBe('PICKED_UP');
    });
  });

  describe('a service', () => {
    // A service happens at one address, so there is nothing to follow: no sharing, no live view.
    async function serviceScene() {
      const s = await acceptedScene(app, serviceId, { locationType: 'ERRAND_DESTINATION' });
      await consent(s.runner);
      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
      return s;
    }

    it('refuses a location from the runner, with a clear reason, and stores nothing', async () => {
      const s = await serviceScene();
      const res = await share(s.runner, s.assignmentId).expect(404);
      expect(res.body.error.code).toBe('LOCATION_NOT_AVAILABLE');
      expect(res.body.error.details).toMatchObject({ reason: 'SERVICE' });
      expect(await prisma.$queryRaw`SELECT 1 FROM location_records WHERE assignment_id = ${s.assignmentId}::uuid`).toHaveLength(0);
    });

    it('shows the requester no live view', async () => {
      const s = await serviceScene();
      expect((await live(s.requester, s.assignmentId).expect(404)).body.error.code).toBe('LOCATION_NOT_AVAILABLE');
      expect((await live(s.runner, s.assignmentId).expect(404)).body.error.code).toBe('LOCATION_NOT_AVAILABLE');
    });

    it('has no sharing to turn on or off', async () => {
      const s = await serviceScene();
      expect((await sharing(s.runner, s.assignmentId, false).expect(404)).body.error.code).toBe('LOCATION_NOT_AVAILABLE');
      expect((await sharing(s.runner, s.assignmentId, true).expect(404)).body.error.code).toBe('LOCATION_NOT_AVAILABLE');
    });

    it('still lets a delivery share and be followed as before', async () => {
      const s = await sharingRunner();
      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
      await share(s.runner, s.assignmentId).expect(200);
      expect((await live(s.requester, s.assignmentId).expect(200)).body.data.sharing).toBe('ACTIVE');
    });
  });

  describe('estimated arrival', () => {
    it('is given only for a fresh position and a traffic-aware estimate', async () => {
      const s = await sharingRunner();
      await share(s.runner, s.assignmentId).expect(200);
      const view = (await live(s.requester, s.assignmentId).expect(200)).body.data;

      // The fake maps provider answers a plain distance, not a traffic-aware one.
      expect(view.freshness).toBe('FRESH');
      expect(view.estimatedArrivalMinutes).toBeNull();
    });

    it('is given when the provider has a traffic-aware estimate', async () => {
      const s = await sharingRunner();
      await share(s.runner, s.assignmentId).expect(200);
      app.get<FakeMapsProvider>(MAPS_PROVIDER).scriptOutcomes('calculateDistance', [
        { success: true, distanceMeters: 4200, durationSeconds: 14 * 60 + 5, trafficAware: true },
      ]);

      const view = (await live(s.requester, s.assignmentId).expect(200)).body.data;

      expect(view.estimatedArrivalMinutes).toBe(15);
    });

    it('is left out when the estimate is not traffic-aware, or the maps provider fails', async () => {
      const s = await sharingRunner();
      await share(s.runner, s.assignmentId).expect(200);
      const maps = app.get<FakeMapsProvider>(MAPS_PROVIDER);

      maps.scriptOutcomes('calculateDistance', [{ success: true, distanceMeters: 4200, durationSeconds: 600, trafficAware: false }]);
      expect((await live(s.requester, s.assignmentId).expect(200)).body.data.estimatedArrivalMinutes).toBeNull();
      maps.scriptOutcomes('calculateDistance', [{ success: false, error: 'quota exceeded' }]);
      expect((await live(s.requester, s.assignmentId).expect(200)).body.data.estimatedArrivalMinutes).toBeNull();
    });
  });

  describe('retention (Backend PRD 17.6)', () => {
    it('removes positions older than the retention period', async () => {
      const s = await sharingRunner();
      await share(s.runner, s.assignmentId).expect(200);
      await prisma.$executeRaw`UPDATE location_records SET captured_at = now() - interval '31 days'`;
      await prisma.$executeRaw`
        INSERT INTO location_records (assignment_id, user_id, point, captured_at)
        VALUES (${s.assignmentId}::uuid, ${s.runner.userId}::uuid, ST_SetSRID(ST_MakePoint(3.4, 6.5), 4326)::geography, now() - interval '5 days')`;

      const removed = await app.get(RunnerLocationService).purgeExpired();

      expect(removed).toBe(1);
      expect(await prisma.locationRecord.count()).toBe(1);
    });
  });

  describe('schema', () => {
    it('refuses a position from anyone but the runner', async () => {
      const s = await sharingRunner();

      await expect(
        prisma.$executeRaw`
          INSERT INTO location_records (assignment_id, user_id, point, captured_at)
          VALUES (${s.assignmentId}::uuid, ${s.requester.userId}::uuid, ST_SetSRID(ST_MakePoint(3.4, 6.5), 4326)::geography, now())`,
      ).rejects.toThrow();
    });
  });
});

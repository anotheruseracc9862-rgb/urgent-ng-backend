/**
 * P9-06: trusted-contact links (Backend PRD 17.5). The public view carries no exact address, phone,
 * chat or GPS history; the link is hashed, limited, expiring and revocable. HTTP, real PostgreSQL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { acceptedScene, executionStep, selectedScene } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { readyMedia } from '../test/media.helper.js';
import { TrustedContactService } from './trusted-contact.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Trusted contact (P9-06)', () => {
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
  const make = (user: Authed, errandId: string) =>
    request(app.getHttpServer())
      .post(`${API}/errands/${errandId}/trusted-contact`)
      .set(...bearer(user.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({});
  const list = (user: Authed, errandId: string) =>
    request(app.getHttpServer()).get(`${API}/errands/${errandId}/trusted-contact`).set(...bearer(user.accessToken));
  const revoke = (user: Authed, shareId: string) =>
    request(app.getHttpServer()).delete(`${API}/trusted-contact/${shareId}`).set(...bearer(user.accessToken));
  const view = (token: string) => request(app.getHttpServer()).get(`${API}/shared/${token}`);
  const concern = (token: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(`${API}/shared/${token}/concern`).send(body);
  const consent = (user: Authed) =>
    request(app.getHttpServer()).post(`${API}/me/consents`).set(...bearer(user.accessToken)).send({ type: 'LOCATION_SHARING', version: '1.0' }).expect(200);

  describe('creating', () => {
    it('gives the creator a one-time token and stores only its hash', async () => {
      const s = await acceptedScene(app, categoryId);

      const res = await make(s.requester, s.errandId).expect(201);

      const { id, token, path, expiresAt } = res.body.data;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(path).toBe(`/shared/${token}`);
      const row = await prisma.trustedContactShare.findUniqueOrThrow({ where: { id } });
      expect(row.tokenHash).not.toContain(token);
      expect(row).toMatchObject({ createdBy: s.requester.userId, status: 'ACTIVE', viewCount: 0 });
      // The 48 hour cap from creation.
      expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(47 * 3_600_000);
      expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(48 * 3_600_000 + 5000);
      // The token never comes back from the list.
      const listed = (await list(s.requester, s.errandId).expect(200)).body.data;
      expect(JSON.stringify(listed)).not.toContain(token);
    });

    it('lets the assigned runner make one too, and keeps their links from the other side', async () => {
      const s = await acceptedScene(app, categoryId);
      const mine = (await make(s.runner, s.errandId).expect(201)).body.data;
      const requestersOwn = (await make(s.requester, s.errandId).expect(201)).body.data;

      const runnerSees = (await list(s.runner, s.errandId).expect(200)).body.data;
      const requesterSees = (await list(s.requester, s.errandId).expect(200)).body.data;

      expect(runnerSees.map((l: { id: string }) => l.id)).toEqual([mine.id]);
      expect(requesterSees.map((l: { id: string }) => l.id).sort()).toEqual([mine.id, requestersOwn.id].sort());
      expect(runnerSees[0].createdByMe).toBe(true);
    });

    it('is closed to strangers and to an errand that is not yet active', async () => {
      const s = await acceptedScene(app, categoryId);
      const stranger = await signedInUser(app);
      expect((await make(stranger, s.errandId)).status).toBe(404);
      expect((await list(stranger, s.errandId)).status).toBe(404);

      const pending = await selectedScene(app, categoryId);
      const res = await make(pending.requester, pending.errandId);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ERRAND_INVALID_STATE');
    });

    it('allows five active links on an errand and no more', async () => {
      const s = await acceptedScene(app, categoryId);
      for (let i = 0; i < 5; i += 1) await make(s.requester, s.errandId).expect(201);

      const sixth = await make(s.requester, s.errandId);

      expect(sixth.status).toBe(409);
      expect(sixth.body.error.details.reason).toBe('LINK_LIMIT');
    });
  });

  describe('the public view', () => {
    it('shows only the allowed fields, and logs the view', async () => {
      const s = await acceptedScene(app, categoryId);
      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
      const { token, id } = (await make(s.requester, s.errandId).expect(201)).body.data;

      const res = await view(token).expect(200);

      expect(res.headers['x-robots-tag']).toContain('noindex');
      const data = res.body.data;
      expect(Object.keys(data).sort()).toEqual(
        ['category', 'categoryFlow', 'checkpoints', 'destination', 'expectedDeliveryAt', 'lastUpdatedAt', 'linkExpiresAt', 'live', 'pickup', 'requesterFirstName', 'runner', 'status', 'title'].sort(),
      );
      expect(data.status).toBe('IN_PROGRESS');
      expect(data.categoryFlow).toBe('TRANSIT');
      expect(data.runner.lastInitial).toHaveLength(1);
      expect(Object.keys(data.runner).sort()).toEqual(['firstName', 'lastInitial', 'photoUrl', 'ratingAverage', 'ratingCount', 'verified']);
      expect(data.runner.verified).toBe(true);
      expect(data.pickup).toMatchObject({ area: expect.any(String) });
      expect(Object.keys(data.pickup).sort()).toEqual(['area', 'lat', 'lga', 'lng', 'state']);

      // Nothing sensitive in the whole payload: no phone, email, address text or contact.
      const runner = await prisma.user.findUniqueOrThrow({ where: { id: s.runner.userId } });
      const requester = await prisma.user.findUniqueOrThrow({ where: { id: s.requester.userId } });
      const text = JSON.stringify(res.body);
      for (const secret of [runner.phoneE164, runner.email, requester.phoneE164, requester.email]) {
        if (secret) expect(text).not.toContain(secret);
      }
      expect(text).not.toMatch(/address|landmark|contact|exact|phone/i);
      expect(text).not.toContain(s.runner.userId);
      expect(text).not.toContain(s.requester.userId);

      const row = await prisma.trustedContactShare.findUniqueOrThrow({ where: { id } });
      expect(row.viewCount).toBe(1);
      expect(row.lastViewedAt).not.toBeNull();
      await view(token).expect(200);
      expect((await prisma.trustedContactShare.findUniqueOrThrow({ where: { id } })).viewCount).toBe(2);
    });

    it('shows the runner on a rounded point with a freshness, never the exact position', async () => {
      const s = await acceptedScene(app, categoryId);
      await consent(s.runner);
      const exact = { lat: 6.51234, lng: 3.37654 };
      await request(app.getHttpServer()).post(`${API}/assignments/${s.assignmentId}/location`).set(...bearer(s.runner.accessToken)).send(exact).expect(200);
      const { token } = (await make(s.requester, s.errandId).expect(201)).body.data;

      const data = (await view(token).expect(200)).body.data;

      expect(data.live).toMatchObject({ freshness: 'FRESH' });
      expect(data.live.lat).not.toBe(exact.lat);
      expect(Math.abs(data.live.lat - exact.lat) * 111_320).toBeLessThan(260);
      expect(JSON.stringify(data)).not.toContain(String(exact.lat));
    });

    it('rounds the pickup and destination areas to a coarse grid', async () => {
      const s = await acceptedScene(app, categoryId);
      const { token } = (await make(s.requester, s.errandId).expect(201)).body.data;
      const stored = await prisma.$queryRaw<Array<{ lat: number }>>`
        SELECT ST_Y(approx_point::geometry) AS lat FROM errand_locations WHERE errand_id = ${s.errandId}::uuid AND type = 'ERRAND_PICKUP'::"LocationType"`;

      const data = (await view(token).expect(200)).body.data;

      expect(data.pickup).not.toBeNull();
      expect(Math.abs(data.pickup.lat - stored[0].lat) * 111_320).toBeLessThan(600);
    });

    it('gives the runner a short-lived photo link that only the share can use', async () => {
      const s = await acceptedScene(app, categoryId);
      const photo = await readyMedia(app, s.runner.accessToken, 'PROFILE_PHOTO');
      await request(app.getHttpServer()).put(`${API}/me/photo`).set(...bearer(s.runner.accessToken)).send({ mediaId: photo }).expect(200);
      const { token } = (await make(s.requester, s.errandId).expect(201)).body.data;

      const data = (await view(token).expect(200)).body.data;

      expect(data.runner.photoUrl).toEqual(expect.stringMatching(/^https?:\/\//));
    });

    it('has the delivery estimate from acceptance, replaced by the newest delay notice', async () => {
      const s = await acceptedScene(app, categoryId);
      const { token } = (await make(s.requester, s.errandId).expect(201)).body.data;
      const planned = (await view(token).expect(200)).body.data.expectedDeliveryAt;
      expect(planned).toBeTruthy();

      await request(app.getHttpServer())
        .post(`${API}/assignments/${s.assignmentId}/delay-notices`)
        .set(...bearer(s.runner.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'TRAFFIC', newEstimateMinutes: 90 })
        .expect(201);

      const after = (await view(token).expect(200)).body.data.expectedDeliveryAt;
      expect(new Date(after).getTime() - Date.now()).toBeGreaterThan(80 * 60_000);
      expect(new Date(after).getTime() - Date.now()).toBeLessThan(95 * 60_000);
    });

    it('answers "not found" the same way for unknown, malformed, revoked and expired links', async () => {
      const s = await acceptedScene(app, categoryId);
      const revoked = (await make(s.requester, s.errandId).expect(201)).body.data;
      const expired = (await make(s.requester, s.errandId).expect(201)).body.data;
      await revoke(s.requester, revoked.id).expect(200);
      await prisma.$executeRaw`UPDATE trusted_contact_shares SET expires_at = now() - interval '1 minute' WHERE id = ${expired.id}::uuid`;

      const bodies = await Promise.all(
        [randomUUID().replace(/-/g, ''), 'short', 'A'.repeat(43), revoked.token, expired.token].map(async (token) => {
          const res = await view(token);
          expect(res.status, token).toBe(404);
          return res.body.error.code;
        }),
      );

      expect(new Set(bodies)).toEqual(new Set(['RESOURCE_NOT_FOUND']));
    });
  });

  describe('a service', () => {
    it('reports its flow and has one area, the destination, and no pickup', async () => {
      const s = await acceptedScene(app, serviceId, { locationType: 'ERRAND_DESTINATION' });
      const { token } = (await make(s.requester, s.errandId).expect(201)).body.data;

      const data = (await view(token).expect(200)).body.data;

      expect(data).toMatchObject({ category: 'Home Cleaning', categoryFlow: 'SERVICE', pickup: null });
      expect(data.destination).toMatchObject({ area: expect.any(String) });
    });
  });

  describe('lifetime', () => {
    it('ends two hours after the errand does', async () => {
      const s = await acceptedScene(app, categoryId);
      const { token } = (await make(s.requester, s.errandId).expect(201)).body.data;
      for (const name of ['start', 'pickup', 'deliver'] as const) {
        await executionStep(app, s.runner, s.assignmentId, name).expect(201);
      }
      await request(app.getHttpServer())
        .post(`${API}/errands/${s.errandId}/complete`)
        .set(...bearer(s.requester.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(201);

      // Just completed: the contact can still see how it ended.
      const during = await view(token).expect(200);
      expect(during.body.data.status).toBe('COMPLETED');
      expect(during.body.data.live).toBeNull();
      expect(new Date(during.body.data.linkExpiresAt).getTime() - Date.now()).toBeLessThanOrEqual(2 * 3_600_000 + 5000);

      await prisma.$executeRaw`UPDATE errands SET completed_at = now() - interval '3 hours' WHERE id = ${s.errandId}::uuid`;
      expect((await view(token)).status).toBe(404);
    });

    it('is marked EXPIRED by the sweeper once the window has passed', async () => {
      const s = await acceptedScene(app, categoryId);
      const { id } = (await make(s.requester, s.errandId).expect(201)).body.data;
      await prisma.$executeRaw`UPDATE trusted_contact_shares SET expires_at = now() - interval '1 minute' WHERE id = ${id}::uuid`;

      expect(await app.get(TrustedContactService).expireDue()).toBe(1);
      expect(await app.get(TrustedContactService).expireDue()).toBe(0);

      expect((await prisma.trustedContactShare.findUniqueOrThrow({ where: { id } })).status).toBe('EXPIRED');
    });

    it('is ended by its creator or by the requester, and stays ended', async () => {
      const s = await acceptedScene(app, categoryId);
      const runnersLink = (await make(s.runner, s.errandId).expect(201)).body.data;
      const stranger = await signedInUser(app);

      expect((await revoke(stranger, runnersLink.id)).status).toBe(404);
      const ended = (await revoke(s.requester, runnersLink.id).expect(200)).body.data;
      expect(ended.status).toBe('REVOKED');
      expect((await revoke(s.runner, runnersLink.id).expect(200)).body.data.status).toBe('REVOKED');
      expect((await view(runnersLink.token)).status).toBe(404);
    });
  });

  describe('safety concern', () => {
    it('becomes a report from the link creator, and tells them', async () => {
      const s = await acceptedScene(app, categoryId);
      const { token } = (await make(s.requester, s.errandId).expect(201)).body.data;

      const res = await concern(token, { message: 'They have not answered for an hour.' }).expect(200);

      expect(res.body.data).toEqual({ received: true });
      const report = await prisma.report.findFirstOrThrow({ where: { reporterId: s.requester.userId } });
      expect(report).toMatchObject({ targetUserId: s.runner.userId, type: 'UNSAFE_BEHAVIOR', errandId: s.errandId, status: 'OPEN' });
      expect(report.description).toContain('trusted contact');
      await dispatchOutbox(app, { eventType: 'trusted_contact.concern' });
      const notices = (await request(app.getHttpServer()).get(`${API}/notifications`).set(...bearer(s.requester.accessToken)).expect(200)).body.data as Array<{ type: string }>;
      expect(notices.map((n) => n.type)).toContain('trusted_contact.concern');
    });

    it('is refused for a link that is not live, and the description stays short', async () => {
      const s = await acceptedScene(app, categoryId);
      const link = (await make(s.requester, s.errandId).expect(201)).body.data;

      expect((await concern(link.token, { message: 'x'.repeat(501) })).status).toBe(400);
      await revoke(s.requester, link.id).expect(200);
      expect((await concern(link.token)).status).toBe(404);
      expect(await prisma.report.count()).toBe(0);
    });
  });
});

/**
 * P9-08: risk signals (Backend PRD 21.6). Each emitter raises a flag for an admin and never blocks
 * the user. Real PostgreSQL and Redis.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, lastCode, registerUser, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { insertErrand, openErrand, seedCategories } from '../test/errand.helper.js';
import { acceptedScene, completedFor, completedScene } from '../test/assignment.helper.js';
import { submitOffer } from '../test/offer.helper.js';
import { profileBody, readyRunner } from '../test/verification.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { RiskFlagService } from './risk-flag.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Risk signals (P9-08)', () => {
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

  type Authed = { accessToken: string; userId: string };
  const flags = (signal?: string) => prisma.riskFlag.findMany({ where: signal ? { signal } : {}, orderBy: { createdAt: 'asc' } });
  const setConfig = (key: string, value: unknown) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO config_values (key, value_json, version, effective_from, updated_at)
       VALUES ($1, $2::jsonb, 1, now() - interval '1 minute', now())`,
      key,
      JSON.stringify(value),
    );
  const adminId = async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO admins (email, display_name, password_hash, status, updated_at)
      VALUES (${`admin-${randomUUID()}@urgent.ng`}, 'Test Admin', 'x', 'ACTIVE'::"AdminStatus", now())
      RETURNING id::text`;
    return rows[0].id;
  };
  const rate = (user: Authed, assignmentId: string, overall: number) =>
    request(app.getHttpServer())
      .post(`${API}/assignments/${assignmentId}/ratings`)
      .set(...bearer(user.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ scores: { overall } });

  describe('emitters', () => {
    it('OTP_ABUSE: used-up attempts, with a digest and no phone number', async () => {
      const user = await registerUser(app);
      const code = lastCode(app, user.phone);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i += 1) {
        await request(app.getHttpServer()).post(`${API}/auth/otp/verify`).send({ phone: user.phone, code: wrong }).expect(400);
      }

      const sixth = await request(app.getHttpServer()).post(`${API}/auth/otp/verify`).send({ phone: user.phone, code: wrong });

      // The user gets the normal answer: the flag changes nothing for them.
      expect(sixth.status).toBe(429);
      const [flag] = await flags('OTP_ABUSE');
      expect(flag).toMatchObject({ signal: 'OTP_ABUSE', status: 'OPEN', userId: null, occurrences: 1 });
      expect(flag.details).toMatchObject({ reason: 'attempts_exceeded', purpose: 'REGISTRATION' });
      expect(JSON.stringify(flag)).not.toContain(user.phone);
      expect(flag.subjectKey).toBeTruthy();
    });

    it('OFFER_SPAM: many offers in an hour, and the runner is not stopped', async () => {
      await setConfig('RISK_OFFER_SPAM_PER_HOUR', 2);
      const runner = await readyRunner(app);
      const requester = await signedInUser(app);
      for (let i = 0; i < 3; i += 1) {
        const errandId = await insertErrand({ requesterId: requester.userId, categoryId });
        await submitOffer(app, runner, errandId).expect(201);
      }

      await dispatchOutbox(app, { eventType: 'offer.created' });

      const [flag] = await flags('OFFER_SPAM');
      expect(flag).toMatchObject({ userId: runner.userId, status: 'OPEN' });
      // Every offer event saw the runner over the line: one row, counted.
      expect(await flags('OFFER_SPAM')).toHaveLength(1);
      expect(flag.occurrences).toBeGreaterThanOrEqual(2);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: runner.userId } })).toMatchObject({ status: 'ACTIVE' });
      // Still free to offer.
      const another = await insertErrand({ requesterId: requester.userId, categoryId });
      await submitOffer(app, runner, another).expect(201);
    });

    it('FEED_PROBING: one errand viewed from many operating-area centres', async () => {
      await setConfig('RISK_PROBE_DISTINCT_POSITIONS', 3);
      const requester = await signedInUser(app);
      const errandId = await openErrand(app, requester, categoryId);
      const runner = await readyRunner(app, '50000011234');
      const view = () => request(app.getHttpServer()).get(`${API}/marketplace/errands/${errandId}`).set(...bearer(runner.accessToken));
      const move = (lat: number) =>
        request(app.getHttpServer())
          .put(`${API}/runner/profile`)
          .set(...bearer(runner.accessToken))
          .send(profileBody({ areaCenter: { lat, lng: 3.3792 } }))
          .expect(200);

      for (const lat of [6.5244, 6.5254, 6.5264]) {
        await move(lat);
        await view().expect(200);
      }

      const [flag] = await flags('FEED_PROBING');
      expect(flag).toMatchObject({ userId: runner.userId, errandId, status: 'OPEN' });
      expect(flag.details).toMatchObject({ distinctPositions: 3 });
      // Viewing again is not refused.
      await view().expect(200);
    });

    it('FEED_PROBING: the same centre again and again is not probing', async () => {
      await setConfig('RISK_PROBE_DISTINCT_POSITIONS', 2);
      const requester = await signedInUser(app);
      const errandId = await openErrand(app, requester, categoryId);
      const runner = await readyRunner(app, '50000021234');
      for (let i = 0; i < 4; i += 1) {
        await request(app.getHttpServer()).get(`${API}/marketplace/errands/${errandId}`).set(...bearer(runner.accessToken)).expect(200);
      }

      expect(await flags('FEED_PROBING')).toHaveLength(0);
    });

    it('RATING_ANOMALY: a cluster of very low ratings on one person', async () => {
      await setConfig('RISK_LOW_RATING_COUNT', 2);
      const first = await completedScene(app, categoryId);
      const second = await completedFor(app, categoryId, first.runner);
      for (const job of [first, second]) {
        await rate(job.requester, job.assignmentId, 1).expect(201);
        await rate(first.runner, job.assignmentId, 5).expect(201);
      }

      await dispatchOutbox(app, { eventType: 'rating.revealed' });

      const [flag] = await flags('RATING_ANOMALY');
      expect(flag).toMatchObject({ userId: first.runner.userId, status: 'OPEN' });
      expect(flag.details).toMatchObject({ lowRatings: 2, distinctRaters: 2 });
    });

    it('SELF_DEALING: the same two accounts completing errand after errand', async () => {
      await setConfig('RISK_REPEAT_PAIR_COUNT', 2);
      const first = await completedScene(app, categoryId);
      const second = await completedFor(app, categoryId, first.runner, { requester: first.requester });

      await dispatchOutbox(app, { eventType: 'errand.completed' });

      const rows = await flags('SELF_DEALING');
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.userId === first.runner.userId)).toBe(true);
      expect(rows[0].details).toMatchObject({ counterpartyUserId: first.requester.userId, completedTogether: expect.any(Number) });
      void second;
    });

    it('SELF_DEALING: a one-off pair is not flagged', async () => {
      await completedScene(app, categoryId);
      await dispatchOutbox(app, { eventType: 'errand.completed' });
      expect(await flags('SELF_DEALING')).toHaveLength(0);
    });

    it('LOCATION_ANOMALY: an impossible jump reported by the location service', async () => {
      const s = await acceptedScene(app, categoryId);
      await request(app.getHttpServer()).post(`${API}/me/consents`).set(...bearer(s.runner.accessToken)).send({ type: 'LOCATION_SHARING', version: '1.0' }).expect(200);
      const send = (lat: number, lng: number) =>
        request(app.getHttpServer()).post(`${API}/assignments/${s.assignmentId}/location`).set(...bearer(s.runner.accessToken)).send({ lat, lng });
      await send(6.5244, 3.3792).expect(200);
      await prisma.$executeRaw`UPDATE location_records SET captured_at = now() - interval '60 seconds', received_at = now() - interval '60 seconds'`;
      await send(12.0, 8.5).expect(200);

      await dispatchOutbox(app, { eventType: 'runner_location.anomaly' });

      const [flag] = await flags('LOCATION_ANOMALY');
      expect(flag).toMatchObject({ userId: s.runner.userId, errandId: s.errandId, status: 'OPEN' });
      // A signal, not an exact position: only the size of the jump.
      expect(JSON.stringify(flag.details)).not.toMatch(/6\.52|3\.37|12\.0|8\.5/);
    });
  });

  describe('the flag itself', () => {
    it('counts a repeated signal instead of adding rows, and a reviewed flag starts a new one', async () => {
      const user = await signedInUser(app);
      const service = app.get(RiskFlagService);
      const raise = () => service.raise(prisma, { signal: 'OFFER_SPAM', userId: user.userId, details: { offersInLastHour: 9 } });

      expect(await raise()).toBe(true);
      expect(await raise()).toBe(false);
      expect(await raise()).toBe(false);

      const [flag] = await flags('OFFER_SPAM');
      expect(flag.occurrences).toBe(3);
      expect(await flags('OFFER_SPAM')).toHaveLength(1);
      await service.review(flag.id, 'DISMISSED', 'Bulk poster, fine.', { adminId: await adminId() });
      expect(await raise()).toBe(true);
      expect(await flags('OFFER_SPAM')).toHaveLength(2);
    });

    it('keeps different subjects apart', async () => {
      const a = await signedInUser(app);
      const b = await signedInUser(app);
      const service = app.get(RiskFlagService);

      await service.raise(prisma, { signal: 'OFFER_SPAM', userId: a.userId });
      await service.raise(prisma, { signal: 'OFFER_SPAM', userId: b.userId });
      await service.raise(prisma, { signal: 'OTP_ABUSE', subjectKey: 'dest:one' });
      await service.raise(prisma, { signal: 'OTP_ABUSE', subjectKey: 'dest:two' });

      expect(await flags()).toHaveLength(4);
    });

    it('never changes the user it is about', async () => {
      const user = await signedInUser(app);
      await app.get(RiskFlagService).raise(prisma, { signal: 'SELF_DEALING', userId: user.userId });

      expect(await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).toMatchObject({ status: 'ACTIVE' });
      expect(await prisma.userRestriction.count({ where: { userId: user.userId } })).toBe(0);
      expect(await prisma.enforcementAction.count({ where: { userId: user.userId } })).toBe(0);
      const me = await request(app.getHttpServer()).get(`${API}/me`).set(...bearer(user.accessToken));
      expect(me.status).toBe(200);
    });

    it('is a review queue: filtered, paged, reviewed once, audited', async () => {
      const service = app.get(RiskFlagService);
      const users = [await signedInUser(app), await signedInUser(app), await signedInUser(app)];
      for (const user of users) await service.raise(prisma, { signal: 'OFFER_SPAM', userId: user.userId });
      await service.raise(prisma, { signal: 'FEED_PROBING', userId: users[0].userId });

      const spam = await service.list({ signal: 'OFFER_SPAM', limit: 2 });
      expect(spam.items).toHaveLength(2);
      expect(spam.meta.hasNextPage).toBe(true);
      const rest = await service.list({ signal: 'OFFER_SPAM', limit: 2, cursor: spam.meta.nextCursor });
      expect(rest.items).toHaveLength(1);
      expect((await service.list({ userId: users[0].userId })).items).toHaveLength(2);

      const admin = await adminId();
      const target = spam.items[0];
      const reviewed = await service.review(target.id, 'ACTIONED', 'Warned them.', { adminId: admin });
      expect(reviewed).toMatchObject({ status: 'ACTIONED', reviewedBy: admin, reviewNote: 'Warned them.' });
      await expect(service.review(target.id, 'DISMISSED', 'again', { adminId: admin })).rejects.toMatchObject({ code: 'ERRAND_INVALID_STATE' });
      await expect(service.review(randomUUID(), 'REVIEWED', 'x', { adminId: admin })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect((await service.list({ status: 'OPEN' })).items.every((f) => f.status === 'OPEN')).toBe(true);
      expect(await prisma.auditLog.count({ where: { action: 'risk_flag.reviewed', entityId: target.id } })).toBe(1);
    });

    it('is soft-deletable only', async () => {
      const user = await signedInUser(app);
      await app.get(RiskFlagService).raise(prisma, { signal: 'OFFER_SPAM', userId: user.userId });
      const [flag] = await flags();

      await expect(prisma.$executeRaw`DELETE FROM risk_flags WHERE id = ${flag.id}::uuid`).rejects.toThrow();
    });
  });
});

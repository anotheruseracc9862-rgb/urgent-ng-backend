/**
 * Runner lists (Backend PRD 30.2) and the account-deletion blocker for in-flight errands
 * (Backend PRD 9.5, 36.8). HTTP only, real PostgreSQL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { insertErrand, LAGOS_PICKUP, seedCategories } from '../test/errand.helper.js';
import { readyRunner } from '../test/verification.helper.js';
import { submitOffer } from '../test/offer.helper.js';
import {
  acceptAssignment,
  acceptedScene,
  cancelAssignment,
  completeErrand,
  executionStep,
  selectRunner,
  selectedScene,
  uniqueNin,
} from '../test/assignment.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Runner lists and deletion blockers', () => {
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

  type Authed = { accessToken: string };
  const get = (user: Authed, path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(user.accessToken));
  const requestDeletion = (user: Authed) =>
    request(app.getHttpServer()).post(`${API}/me/delete-request`).set(...bearer(user.accessToken)).send({ reason: 'leaving' });

  describe('GET /runner/assignments', () => {
    it('lists the runner\'s own assignments, newest first, with areas only, and filters by group or status', async () => {
      const runner = await readyRunner(app, uniqueNin(700));
      const requester = await signedInUser(app);
      const make = async () => {
        const errandId = await insertErrand({ requesterId: requester.userId, categoryId, area: 'Yaba' });
        const offer = (await submitOffer(app, runner, errandId).expect(201)).body.data;
        const selected = (await selectRunner(app, requester, errandId, offer.id, offer.version).expect(201)).body.data;
        return { errandId, assignmentId: selected.id as string };
      };
      const first = await make();
      const second = await make();
      await acceptAssignment(app, runner, first.assignmentId).expect(201);
      await cancelAssignment(app, requester, first.assignmentId).expect(200);

      const all = await get(runner, '/runner/assignments').expect(200);
      expect(all.body.data.map((r: { id: string }) => r.id)).toEqual([second.assignmentId, first.assignmentId]);
      expect(all.body.data[0]).toMatchObject({ status: 'PENDING_ACCEPTANCE', errandStatus: 'RUNNER_SELECTED', pickupArea: 'Yaba' });
      expect(JSON.stringify(all.body.data)).not.toContain('exact');
      // A map gets the approximate point (the helper offsets it from the exact one by 0.002), never the exact one.
      expect(all.body.data[0].pickupApprox.lat).toBeCloseTo(LAGOS_PICKUP.lat + 0.002, 6);
      expect(all.body.data[0].pickupApprox.lng).toBeCloseTo(LAGOS_PICKUP.lng + 0.002, 6);
      expect(all.body.data[0].destinationApprox).toBeNull();

      const active = await get(runner, '/runner/assignments?status=ACTIVE').expect(200);
      expect(active.body.data.map((r: { id: string }) => r.id)).toEqual([second.assignmentId]);
      const past = await get(runner, '/runner/assignments?status=PAST').expect(200);
      expect(past.body.data.map((r: { id: string }) => r.id)).toEqual([first.assignmentId]);
      const exact = await get(runner, '/runner/assignments?status=CANCELLED').expect(200);
      expect(exact.body.data).toHaveLength(1);
      expect((await get(runner, '/runner/assignments?status=NONSENSE')).status).toBe(400);
    });

    it('pages with a cursor and never shows another runner\'s assignments', async () => {
      const s = await acceptedScene(app, categoryId);
      const other = await acceptedScene(app, categoryId);

      const page = await get(s.runner, '/runner/assignments?limit=1').expect(200);
      expect(page.body.data).toHaveLength(1);
      expect(page.body.data[0].id).toBe(s.assignmentId);
      expect(page.body.meta.hasNextPage).toBe(false);
      expect(JSON.stringify(page.body)).not.toContain(other.assignmentId);
    });
  });

  describe('GET /runner/offers', () => {
    it('lists the runner\'s own offers with their current state and the errand area', async () => {
      const s = await selectedScene(app, categoryId);
      const other = await selectedScene(app, categoryId);

      const res = await get(s.runner, '/runner/offers').expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: s.offerId,
        errandId: s.errandId,
        status: 'SELECTED',
        amountMinor: 50_000,
        errandStatus: 'RUNNER_SELECTED',
      });
      expect(JSON.stringify(res.body)).not.toContain(other.offerId);
      expect((await get(s.runner, '/runner/offers?status=ACTIVE').expect(200)).body.data).toHaveLength(0);
      expect((await get(s.runner, '/runner/offers?status=SELECTED').expect(200)).body.data).toHaveLength(1);
    });
  });

  describe('account deletion', () => {
    it('is blocked while the user has an open errand, with the reason', async () => {
      const requester = await signedInUser(app);
      await insertErrand({ requesterId: requester.userId, categoryId });

      const res = await requestDeletion(requester);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DELETION_BLOCKED');
      expect(JSON.stringify(res.body.error.details)).toContain('ACTIVE_ERRAND');
    });

    it('is blocked while the runner has a live assignment, and allowed once it is finished', async () => {
      const s = await acceptedScene(app, categoryId);
      const blocked = await requestDeletion(s.runner);
      expect(blocked.status).toBe(409);
      expect(JSON.stringify(blocked.body.error.details)).toContain('ACTIVE_ASSIGNMENT');

      for (const name of ['start', 'pickup', 'deliver'] as const) {
        await executionStep(app, s.runner, s.assignmentId, name).expect(201);
      }
      await completeErrand(app, s.requester, s.errandId).expect(201);

      expect((await requestDeletion(s.runner)).status).toBe(200);
      expect((await requestDeletion(s.requester)).status).toBe(200);
    });

    it('drafts and finished errands do not block', async () => {
      const requester = await signedInUser(app);
      await insertErrand({ requesterId: requester.userId, categoryId, status: 'DRAFT' });
      await insertErrand({ requesterId: requester.userId, categoryId, status: 'CANCELLED' });
      await insertErrand({ requesterId: requester.userId, categoryId, status: 'COMPLETED' });
      expect((await requestDeletion(requester)).status).toBe(200);
      expect(await prisma.errand.count({ where: { requesterId: requester.userId } })).toBe(3);
    });
  });
});

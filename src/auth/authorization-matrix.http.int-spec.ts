/**
 * P12-04: the consumer authorisation matrix of Backend PRD 9.4, one row per action, checked for the
 * requester (errand owner), a runner who is not on the errand, and the assigned runner. A caller
 * with no business on a resource gets 404 (the resource is hidden) or 403, never 2xx.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { createDraft, draftBody, seedCategories } from '../test/errand.helper.js';
import { acceptAssignment, acceptedScene, completeErrand, executionStep, offerScene, selectRunner, selectedScene, uniqueNin } from '../test/assignment.helper.js';
import { submitOffer } from '../test/offer.helper.js';
import { readyRunner } from '../test/verification.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

type Authed = { accessToken: string };
const DENIED = [403, 404];

describe('Authorisation matrix (Backend PRD 9.4)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categoryId: string;
  let nin = 900;

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

  const call = (method: 'get' | 'post' | 'patch' | 'put', user: Authed, path: string, body?: Record<string, unknown>) => {
    const req = request(app.getHttpServer())[method](`${API}${path}`).set(...bearer(user.accessToken));
    if (method !== 'get') req.set('Idempotency-Key', randomUUID()).send(body ?? {});
    return req;
  };
  const denied = async (res: Promise<{ status: number }> | { status: number }, label: string) => {
    const status = (await res).status;
    expect(DENIED, `${label} answered ${status}`).toContain(status);
  };
  const stranger = async () => {
    nin += 1;
    return readyRunner(app, uniqueNin(nin));
  };

  describe('on an open errand', () => {
    it('edit: only the owner', async () => {
      const s = await offerScene(app, categoryId);
      const other = await stranger();
      const draft = (await createDraft(app, s.requester, draftBody(categoryId)).expect(201)).body.data as { id: string };

      for (const id of [draft.id, s.errandId]) {
        await denied(call('patch', other, `/errands/${id}`, { title: 'Hijacked title' }), 'other runner edits');
        await denied(call('patch', s.runner, `/errands/${id}`, { title: 'Hijacked title' }), 'runner with an offer edits');
      }
      const own = await call('patch', s.requester, `/errands/${draft.id}`, { title: 'My new title' });
      expect(own.status, JSON.stringify(own.body)).toBe(200);
    });

    it('view with exact details: only the owner (a runner sees the marketplace view)', async () => {
      const s = await offerScene(app, categoryId);
      const other = await stranger();

      await denied(call('get', other, `/errands/${s.errandId}`), 'other runner reads the owner view');
      expect((await call('get', s.requester, `/errands/${s.errandId}`)).status).toBe(200);
      const market = await call('get', other, `/marketplace/errands/${s.errandId}`);
      expect(market.status).toBe(200);
      expect(JSON.stringify(market.body)).not.toContain('exactPoint');
    });

    it('submit offer: not the owner of the errand, a verified runner can', async () => {
      const s = await offerScene(app, categoryId);
      const other = await stranger();
      const unverified = await signedInUser(app);

      const own = await submitOffer(app, s.requester, s.errandId);
      expect([403, 409, 422], `owner offers on own errand answered ${own.status}`).toContain(own.status);
      const notVerified = await submitOffer(app, unverified, s.errandId);
      expect(notVerified.status, 'unverified user offers').toBeGreaterThanOrEqual(400);
      expect((await submitOffer(app, other, s.errandId)).status).toBe(201);
    });

    it('view and change own offer: only the runner who made it, and the requester sees offers on their errand', async () => {
      const s = await offerScene(app, categoryId);
      const other = await stranger();

      await denied(call('get', other, `/errands/${s.errandId}/offers`), 'other runner lists offers');
      expect((await call('get', s.requester, `/errands/${s.errandId}/offers`)).status).toBe(200);
      await denied(call('post', other, `/offers/${s.offerId}/withdraw`, { expectedVersion: s.offerVersion }), 'other runner withdraws');
      await denied(call('post', s.requester, `/offers/${s.offerId}/withdraw`, { expectedVersion: s.offerVersion }), 'requester withdraws the runner offer');
    });

    it('select runner: only the owner', async () => {
      const s = await offerScene(app, categoryId);
      const other = await stranger();

      await denied(selectRunner(app, other, s.errandId, s.offerId, s.offerVersion), 'other runner selects');
      await denied(selectRunner(app, s.runner, s.errandId, s.offerId, s.offerVersion), 'the offering runner selects themself');
      expect((await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion)).status).toBe(201);
    });
  });

  describe('on a selected errand', () => {
    it('accept: only the selected runner', async () => {
      const s = await selectedScene(app, categoryId);
      const other = await stranger();

      await denied(acceptAssignment(app, s.requester, s.assignmentId), 'requester accepts');
      await denied(acceptAssignment(app, other, s.assignmentId), 'other runner accepts');
      expect((await acceptAssignment(app, s.runner, s.assignmentId)).status).toBe(201);
    });
  });

  describe('on an accepted errand', () => {
    it('start, pick up and deliver: only the assigned runner', async () => {
      const s = await acceptedScene(app, categoryId);
      const other = await stranger();

      for (const step of ['start', 'pickup', 'deliver'] as const) {
        await denied(executionStep(app, s.requester, s.assignmentId, step), `requester ${step}`);
        await denied(executionStep(app, other, s.assignmentId, step), `other runner ${step}`);
      }
      expect((await executionStep(app, s.runner, s.assignmentId, 'start')).status).toBe(201);
    });

    it('confirm completion: only the owner', async () => {
      const s = await acceptedScene(app, categoryId);
      const other = await stranger();
      for (const step of ['start', 'pickup', 'deliver'] as const) {
        await executionStep(app, s.runner, s.assignmentId, step).expect(201);
      }

      await denied(completeErrand(app, s.runner, s.errandId), 'assigned runner completes');
      await denied(completeErrand(app, other, s.errandId), 'other runner completes');
      expect((await completeErrand(app, s.requester, s.errandId)).status).toBe(201);
    });

    it('see the assignment: only its two parties', async () => {
      const s = await acceptedScene(app, categoryId);
      const other = await stranger();

      await denied(call('get', other, `/assignments/${s.assignmentId}`), 'other runner reads the assignment');
      await denied(call('get', other, `/assignments/${s.assignmentId}/timeline`), 'other runner reads the timeline');
      expect((await call('get', s.requester, `/assignments/${s.assignmentId}`)).status).toBe(200);
      expect((await call('get', s.runner, `/assignments/${s.assignmentId}`)).status).toBe(200);
    });

    it('chat: only the two participants', async () => {
      const s = await acceptedScene(app, categoryId);
      const other = await stranger();
      const conversation = await prisma.conversation.findFirstOrThrow({ where: { errandId: s.errandId } });

      await denied(call('get', other, `/conversations/${conversation.id}`), 'other runner reads the conversation');
      await denied(call('get', other, `/conversations/${conversation.id}/messages`), 'other runner reads messages');
      await denied(call('post', other, `/conversations/${conversation.id}/messages`, { type: 'TEXT', body: 'hello' }), 'other runner writes');
      expect((await call('post', s.runner, `/conversations/${conversation.id}/messages`, { type: 'TEXT', body: 'On my way' })).status).toBe(201);
      expect((await call('get', s.requester, `/conversations/${conversation.id}/messages`)).status).toBe(200);
    });

    it('live location: the requester reads it, a stranger does not, and only the runner shares', async () => {
      const s = await acceptedScene(app, categoryId);
      const other = await stranger();

      await denied(call('get', other, `/assignments/${s.assignmentId}/location`), 'other runner reads the location');
      await denied(call('put', s.requester, `/assignments/${s.assignmentId}/location/sharing`, { enabled: true }), 'requester starts sharing');
      expect((await call('get', s.requester, `/assignments/${s.assignmentId}/location`)).status).toBe(200);
    });

    it('trusted-contact link: only the owner creates one', async () => {
      const s = await acceptedScene(app, categoryId);
      const other = await stranger();

      await denied(call('post', other, `/errands/${s.errandId}/trusted-contact`, { reasonCode: 'x' }), 'other runner creates a link');
      await denied(call('get', other, `/errands/${s.errandId}/trusted-contact`), 'other runner reads a link');
    });

    it('report and dispute: only a party of the assignment', async () => {
      const s = await acceptedScene(app, categoryId);
      const other = await stranger();

      await denied(
        call('post', other, `/assignments/${s.assignmentId}/disputes`, { type: 'ITEM_NOT_DELIVERED', claim: 'It never arrived.' }),
        'other runner opens a dispute',
      );
      // Anyone may report an errand they can see. A report from outside the assignment is only a
      // signal for review: it must not pause the errand's auto-completion.
      const report = await call('post', other, '/reports', {
        targetType: 'ERRAND',
        targetId: s.errandId,
        type: 'ERRAND',
        description: 'Looks wrong',
      });
      expect(report.status).toBe(201);
      expect(report.body.data.pausesAutoCompletion ?? false).toBe(false);
      expect((await prisma.errand.findUniqueOrThrow({ where: { id: s.errandId } })).status).toBe('ACCEPTED');
      expect((await call('post', s.requester, `/assignments/${s.assignmentId}/disputes`, { type: 'ITEM_NOT_DELIVERED', claim: 'It never arrived.' })).status).toBe(201);
    });

    it('rating: only a party of a completed assignment', async () => {
      const s = await acceptedScene(app, categoryId);
      const other = await stranger();

      await denied(call('post', other, `/assignments/${s.assignmentId}/ratings`, { scores: { overall: 5 } }), 'other runner rates');
      await denied(call('get', other, `/assignments/${s.assignmentId}/ratings`), 'other runner reads the ratings');
    });
  });

  describe('state and identity are never taken from the client', () => {
    it('ignores a role, status or owner in a request body', async () => {
      const s = await offerScene(app, categoryId);

      const res = await call('patch', s.requester, `/errands/${s.errandId}`, {
        title: 'Honest edit',
        status: 'COMPLETED',
        requesterId: s.runner.userId,
        role: 'ADMIN',
      });
      // Unknown fields are refused outright or ignored; either way nothing changed.
      expect([200, 400]).toContain(res.status);
      const row = await prisma.errand.findUniqueOrThrow({ where: { id: s.errandId } });
      expect(row.status).toBe('OPEN');
      expect(row.requesterId).toBe(s.requester.userId);
    });
  });
});

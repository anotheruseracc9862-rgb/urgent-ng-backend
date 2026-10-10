/**
 * P7-08: problems, delay notices, purchase receipts and the timeline (Backend PRD 15.4, 15.5).
 * None of them changes the errand status or the agreed amount. HTTP only, real PostgreSQL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { readyMedia } from '../test/media.helper.js';
import { acceptedScene, completeErrand, executionStep, selectedScene } from '../test/assignment.helper.js';
import { BusinessConfigService } from '../config/business-config.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Problems, delay notices, receipts, timeline (P7-08)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categories: Record<string, string>;

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

  type Authed = { accessToken: string };
  const post = (user: Authed, path: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(`${API}${path}`).set(...bearer(user.accessToken)).set('Idempotency-Key', randomUUID()).send(body);
  const get = (user: Authed, path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(user.accessToken));
  const errandRow = async (id: string) =>
    (await prisma.$queryRaw<Array<{ status: string }>>`SELECT status::text FROM errands WHERE id = ${id}::uuid`)[0];
  const agreedAmount = async (assignmentId: string) =>
    Number((await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).agreedAmountMinor);

  describe('problems', () => {
    it('are reported by the runner, change nothing about the errand, and are visible to both parties', async () => {
      const s = await acceptedScene(app, categories.delivery);
      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);

      const res = await post(s.runner, `/assignments/${s.assignmentId}/problems`, { type: 'RECIPIENT_UNREACHABLE', note: 'No answer at the gate' }).expect(201);

      expect(res.body.data).toMatchObject({ type: 'RECIPIENT_UNREACHABLE', status: 'OPEN', suggestDispute: false });
      expect((await errandRow(s.errandId)).status).toBe('IN_PROGRESS');
      expect(await agreedAmount(s.assignmentId)).toBe(50_000);
      const event = await prisma.executionEvent.findFirstOrThrow({ where: { assignmentId: s.assignmentId, type: 'PROBLEM_REPORTED' } });
      expect(event.metadata).toMatchObject({ type: 'RECIPIENT_UNREACHABLE' });
      expect(await prisma.outboxEvent.count({ where: { eventType: 'execution.problem_reported', aggregateId: s.assignmentId } })).toBe(1);
      expect((await get(s.requester, `/assignments/${s.assignmentId}/problems`).expect(200)).body.data).toHaveLength(1);
    });

    it('two unresolved problems suggest a dispute; resolving one clears the suggestion', async () => {
      const s = await acceptedScene(app, categories.delivery);
      const first = await post(s.runner, `/assignments/${s.assignmentId}/problems`, { type: 'ITEM_NOT_READY' }).expect(201);
      const second = await post(s.runner, `/assignments/${s.assignmentId}/problems`, { type: 'WRONG_ADDRESS' }).expect(201);
      expect(second.body.data.suggestDispute).toBe(true);

      const resolved = await post(s.runner, `/assignments/${s.assignmentId}/problems/${first.body.data.id}/resolve`).expect(200);

      expect(resolved.body.data).toMatchObject({ status: 'RESOLVED', suggestDispute: false });
      expect(resolved.body.data.resolvedAt).toBeTruthy();
      expect((await post(s.runner, `/assignments/${s.assignmentId}/problems/${first.body.data.id}/resolve`)).status).toBe(409);
    });

    it('only the runner reports or resolves; strangers see nothing', async () => {
      const s = await acceptedScene(app, categories.delivery);
      const stranger = await signedInUser(app);
      expect((await post(s.requester, `/assignments/${s.assignmentId}/problems`, { type: 'OTHER' })).status).toBe(404);
      expect((await post(stranger, `/assignments/${s.assignmentId}/problems`, { type: 'OTHER' })).status).toBe(404);
      const created = await post(s.runner, `/assignments/${s.assignmentId}/problems`, { type: 'OTHER' }).expect(201);
      expect((await post(s.requester, `/assignments/${s.assignmentId}/problems/${created.body.data.id}/resolve`)).status).toBe(404);
      expect((await get(stranger, `/assignments/${s.assignmentId}/problems`)).status).toBe(404);
    });

    it('cannot be reported before acceptance or after delivery', async () => {
      const pending = await selectedScene(app, categories.delivery);
      expect((await post(pending.runner, `/assignments/${pending.assignmentId}/problems`, { type: 'OTHER' })).status).toBe(409);

      const s = await acceptedScene(app, categories.delivery);
      for (const name of ['start', 'pickup', 'deliver'] as const) {
        await executionStep(app, s.runner, s.assignmentId, name).expect(201);
      }
      expect((await post(s.runner, `/assignments/${s.assignmentId}/problems`, { type: 'OTHER' })).status).toBe(409);
    });

    it('takes a photo that both parties may view, and refuses wrong or reused photos', async () => {
      const s = await acceptedScene(app, categories.delivery);
      const stranger = await signedInUser(app);
      const photo = await readyMedia(app, s.runner.accessToken, 'PICKUP_EVIDENCE');

      await post(s.runner, `/assignments/${s.assignmentId}/problems`, { type: 'ITEM_PROBLEM', mediaId: photo }).expect(201);

      await get(s.requester, `/media/${photo}/url`).expect(200);
      await get(s.runner, `/media/${photo}/url`).expect(200);
      expect((await get(stranger, `/media/${photo}/url`)).status).toBe(404);
      expect((await post(s.runner, `/assignments/${s.assignmentId}/problems`, { type: 'ITEM_PROBLEM', mediaId: photo })).body.error.code).toBe('MEDIA_INVALID');
      const wrong = await readyMedia(app, s.runner.accessToken, 'DELIVERY_EVIDENCE');
      expect((await post(s.runner, `/assignments/${s.assignmentId}/problems`, { type: 'ITEM_PROBLEM', mediaId: wrong })).body.error.code).toBe('MEDIA_INVALID');
    });
  });

  describe('delay notices', () => {
    it('are limited to three, carry the new estimate, and change neither status nor amount', async () => {
      const s = await acceptedScene(app, categories.delivery);
      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);

      for (let i = 1; i <= 3; i += 1) {
        const res = await post(s.runner, `/assignments/${s.assignmentId}/delay-notices`, {
          reason: 'TRAFFIC',
          newEstimateMinutes: 20 + i,
          note: `notice ${i}`,
        }).expect(201);
        expect(res.body.data).toMatchObject({ type: 'DELAY_NOTICE', metadata: { reason: 'TRAFFIC', newEstimateMinutes: 20 + i } });
      }
      const fourth = await post(s.runner, `/assignments/${s.assignmentId}/delay-notices`, { reason: 'QUEUE', newEstimateMinutes: 60 });

      expect(fourth.status).toBe(409);
      expect(await prisma.executionEvent.count({ where: { assignmentId: s.assignmentId, type: 'DELAY_NOTICE' } })).toBe(3);
      expect((await errandRow(s.errandId)).status).toBe('IN_PROGRESS');
      expect(await agreedAmount(s.assignmentId)).toBe(50_000);
      expect(await prisma.outboxEvent.count({ where: { eventType: 'execution.delay_notified', aggregateId: s.assignmentId } })).toBe(3);
    });

    it('the limit follows the configuration', async () => {
      await app.get(BusinessConfigService).set('MAX_DELAY_NOTICES_PER_ASSIGNMENT', 1);
      const s = await acceptedScene(app, categories.delivery);
      await post(s.runner, `/assignments/${s.assignmentId}/delay-notices`, { reason: 'OTHER', newEstimateMinutes: 15 }).expect(201);
      expect((await post(s.runner, `/assignments/${s.assignmentId}/delay-notices`, { reason: 'OTHER', newEstimateMinutes: 15 })).status).toBe(409);
    });

    it('validates the reason and the estimate, and is for the runner of an active assignment only', async () => {
      const s = await acceptedScene(app, categories.delivery);
      expect((await post(s.runner, `/assignments/${s.assignmentId}/delay-notices`, { reason: 'LAZY', newEstimateMinutes: 10 })).status).toBe(400);
      expect((await post(s.runner, `/assignments/${s.assignmentId}/delay-notices`, { reason: 'TRAFFIC', newEstimateMinutes: 0 })).status).toBe(400);
      expect((await post(s.requester, `/assignments/${s.assignmentId}/delay-notices`, { reason: 'TRAFFIC', newEstimateMinutes: 10 })).status).toBe(404);

      const pending = await selectedScene(app, categories.delivery);
      expect((await post(pending.runner, `/assignments/${pending.assignmentId}/delay-notices`, { reason: 'TRAFFIC', newEstimateMinutes: 10 })).status).toBe(409);
    });
  });

  describe('purchase receipts', () => {
    it('are refused on a delivery errand', async () => {
      const s = await acceptedScene(app, categories.delivery);
      const receipt = await readyMedia(app, s.runner.accessToken, 'PURCHASE_RECEIPT');
      const res = await post(s.runner, `/assignments/${s.assignmentId}/receipt`, { mediaId: receipt });
      expect(res.status).toBe(400);
    });

    it('are accepted on a shopping errand up to the limit, and both parties can view them', async () => {
      const s = await acceptedScene(app, categories.shopping_purchase);
      const first = await readyMedia(app, s.runner.accessToken, 'PURCHASE_RECEIPT');

      const res = await post(s.runner, `/assignments/${s.assignmentId}/receipt`, { mediaId: first, note: 'Shoprite, 2 items' }).expect(201);

      expect(res.body.data).toMatchObject({ type: 'RECEIPT_ADDED', mediaId: first });
      await get(s.requester, `/media/${first}/url`).expect(200);
      for (let i = 0; i < 2; i += 1) {
        const media = await readyMedia(app, s.runner.accessToken, 'PURCHASE_RECEIPT');
        await post(s.runner, `/assignments/${s.assignmentId}/receipt`, { mediaId: media }).expect(201);
      }
      const extra = await readyMedia(app, s.runner.accessToken, 'PURCHASE_RECEIPT');
      expect((await post(s.runner, `/assignments/${s.assignmentId}/receipt`, { mediaId: extra })).status).toBe(409);
      expect((await errandRow(s.errandId)).status).toBe('ACCEPTED');
      expect(await agreedAmount(s.assignmentId)).toBe(50_000);
    });

    it('may be added after delivery but not after completion, and are never required', async () => {
      const s = await acceptedScene(app, categories.shopping_purchase);
      for (const name of ['start', 'pickup', 'deliver'] as const) {
        await executionStep(app, s.runner, s.assignmentId, name).expect(201);
      }
      const late = await readyMedia(app, s.runner.accessToken, 'PURCHASE_RECEIPT');
      await post(s.runner, `/assignments/${s.assignmentId}/receipt`, { mediaId: late }).expect(201);

      await completeErrand(app, s.requester, s.errandId).expect(201);

      const after = await readyMedia(app, s.runner.accessToken, 'PURCHASE_RECEIPT');
      expect((await post(s.runner, `/assignments/${s.assignmentId}/receipt`, { mediaId: after })).status).toBe(409);
    });

    it('completion works with no receipt at all', async () => {
      const s = await acceptedScene(app, categories.shopping_purchase);
      for (const name of ['start', 'pickup', 'deliver'] as const) {
        await executionStep(app, s.runner, s.assignmentId, name).expect(201);
      }
      await completeErrand(app, s.requester, s.errandId).expect(201);
      expect(await prisma.executionEvent.count({ where: { assignmentId: s.assignmentId, type: 'RECEIPT_ADDED' } })).toBe(0);
    });

    it('refuses a photo of the wrong purpose', async () => {
      const s = await acceptedScene(app, categories.shopping_purchase);
      const wrong = await readyMedia(app, s.runner.accessToken, 'PICKUP_EVIDENCE');
      expect((await post(s.runner, `/assignments/${s.assignmentId}/receipt`, { mediaId: wrong })).body.error.code).toBe('MEDIA_INVALID');
    });
  });

  describe('timeline', () => {
    it('lists the execution events in order for both parties, and nobody else', async () => {
      const s = await acceptedScene(app, categories.delivery);
      const stranger = await signedInUser(app);
      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
      await post(s.runner, `/assignments/${s.assignmentId}/delay-notices`, { reason: 'TRAFFIC', newEstimateMinutes: 25 }).expect(201);
      await post(s.runner, `/assignments/${s.assignmentId}/problems`, { type: 'ITEM_NOT_READY' }).expect(201);

      for (const user of [s.requester, s.runner]) {
        const res = await get(user, `/assignments/${s.assignmentId}/timeline`).expect(200);
        expect(res.body.data.map((e: { type: string }) => e.type)).toEqual(['STARTED', 'DELAY_NOTICE', 'PROBLEM_REPORTED']);
      }
      expect((await get(stranger, `/assignments/${s.assignmentId}/timeline`)).status).toBe(404);
    });
  });
});

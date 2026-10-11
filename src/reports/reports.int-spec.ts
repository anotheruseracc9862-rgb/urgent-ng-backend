/**
 * P9-03: reports (Backend PRD 21.2). A persistent complaint; an open one filed by a party holds the
 * errand's auto-completion. HTTP, real PostgreSQL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { acceptedScene, completedScene, executionStep, offerScene } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { ExecutionService } from '../execution/execution.service.js';
import { DisputeService } from '../disputes/dispute.service.js';
import { ReportService } from './report.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Reports (P9-03)', () => {
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
  const report = (user: Authed, body: Record<string, unknown>, key = randomUUID()) =>
    request(app.getHttpServer()).post(`${API}/reports`).set(...bearer(user.accessToken)).set('Idempotency-Key', key).send(body);
  const userReport = (user: Authed, targetId: string, extra: Record<string, unknown> = {}) =>
    report(user, { targetType: 'USER', targetId, type: 'NON_PAYMENT', description: 'Did not pay what we agreed.', ...extra });
  const errandRow = async (id: string) =>
    (await prisma.$queryRaw<Array<{ status: string; auto_complete_at: Date | null }>>`
      SELECT status::text, auto_complete_at FROM errands WHERE id = ${id}::uuid`)[0];
  const adminId = async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO admins (email, display_name, password_hash, status, updated_at)
      VALUES (${`admin-${randomUUID()}@urgent.ng`}, 'Test Admin', 'x', 'ACTIVE'::"AdminStatus", now())
      RETURNING id::text`;
    return rows[0].id;
  };
  async function delivered() {
    const s = await acceptedScene(app, categoryId);
    for (const name of ['start', 'pickup', 'deliver'] as const) {
      await executionStep(app, s.runner, s.assignmentId, name).expect(201);
    }
    return s;
  }

  describe('filing', () => {
    it('records a report about a user, with a response target, and lists it for the reporter only', async () => {
      const s = await completedScene(app, categoryId);

      const res = await userReport(s.runner, s.requester.userId, {
        assignmentId: s.assignmentId,
        evidence: [{ sourceType: 'STATEMENT', statement: 'We agreed 5,000 at delivery.' }],
      }).expect(201);

      expect(res.body.data).toMatchObject({
        targetType: 'USER',
        type: 'NON_PAYMENT',
        status: 'OPEN',
        outcome: null,
        errandId: s.errandId,
        pausesAutoCompletion: false,
      });
      expect(res.body.data.firstResponseDueAt).toBeTruthy();
      expect(res.body.data.evidence).toHaveLength(1);
      const row = await prisma.report.findUniqueOrThrow({ where: { id: res.body.data.id } });
      expect(row).toMatchObject({ reporterId: s.runner.userId, targetUserId: s.requester.userId, retentionHold: true });

      const mine = await request(app.getHttpServer()).get(`${API}/reports`).set(...bearer(s.runner.accessToken)).expect(200);
      expect(mine.body.data.map((r: { id: string }) => r.id)).toEqual([res.body.data.id]);
      const theirs = await request(app.getHttpServer()).get(`${API}/reports`).set(...bearer(s.requester.accessToken)).expect(200);
      expect(theirs.body.data).toHaveLength(0);
      expect((await request(app.getHttpServer()).get(`${API}/reports/${res.body.data.id}`).set(...bearer(s.requester.accessToken))).status).toBe(404);
    });

    it('validates what is reported', async () => {
      const s = await completedScene(app, categoryId);
      expect((await userReport(s.runner, s.runner.userId)).status).toBe(400);
      expect((await userReport(s.runner, randomUUID())).status).toBe(404);
      expect((await userReport(s.runner, s.requester.userId, { description: '' })).status).toBe(400);
      expect((await userReport(s.runner, s.requester.userId, { type: 'PAYMENT_DISPUTE' })).status).toBe(400);
      expect((await userReport(s.runner, s.requester.userId, { assignmentId: randomUUID() })).status).toBe(404);
      expect(await prisma.report.count()).toBe(0);
    });

    it('reports an errand: the requester is the person reported, a draft cannot be reported', async () => {
      const s = await offerScene(app, categoryId);

      const res = await report(s.runner, { targetType: 'ERRAND', targetId: s.errandId, type: 'PROHIBITED_ITEM', description: 'This looks prohibited.' }).expect(201);
      expect(await prisma.report.findUniqueOrThrow({ where: { id: res.body.data.id } })).toMatchObject({
        targetUserId: s.requester.userId,
        errandId: s.errandId,
      });
      const own = await report(s.requester, { targetType: 'ERRAND', targetId: s.errandId, type: 'OTHER', description: 'x' });
      expect(own.status).toBe(400);
    });

    it('reports a message from a conversation the reporter is in', async () => {
      const s = await offerScene(app, categoryId);
      const conversations = await request(app.getHttpServer()).get(`${API}/conversations`).set(...bearer(s.requester.accessToken)).expect(200);
      const conversationId = conversations.body.data[0].id as string;
      const sent = await request(app.getHttpServer())
        .post(`${API}/conversations/${conversationId}/messages`)
        .set(...bearer(s.runner.accessToken))
        .send({ type: 'TEXT', body: 'Pay me outside the app.' })
        .expect(201);
      const stranger = await signedInUser(app);

      const res = await report(s.requester, { targetType: 'MESSAGE', targetId: sent.body.data.id, type: 'SPAM', description: 'Unwanted.' }).expect(201);

      expect(await prisma.report.findUniqueOrThrow({ where: { id: res.body.data.id } })).toMatchObject({
        targetUserId: s.runner.userId,
        messageId: sent.body.data.id,
        errandId: s.errandId,
      });
      expect((await report(stranger, { targetType: 'MESSAGE', targetId: sent.body.data.id, type: 'SPAM', description: 'x' })).status).toBe(404);
      expect((await report(s.runner, { targetType: 'MESSAGE', targetId: sent.body.data.id, type: 'SPAM', description: 'x' })).status).toBe(400);
    });

    it('reports a rating only once it is visible to the person rated', async () => {
      const s = await completedScene(app, categoryId);
      const rate = (user: Authed, overall: number) =>
        request(app.getHttpServer())
          .post(`${API}/assignments/${s.assignmentId}/ratings`)
          .set(...bearer(user.accessToken))
          .set('Idempotency-Key', randomUUID())
          .send({ scores: { overall }, review: 'unfair' });
      const given = (await rate(s.requester, 1).expect(201)).body.data;
      const reportIt = (user: Authed) =>
        request(app.getHttpServer())
          .post(`${API}/ratings/${given.id}/report`)
          .set(...bearer(user.accessToken))
          .set('Idempotency-Key', randomUUID())
          .send({ type: 'ABUSE', description: 'This review is abusive.' });

      // Hidden until both sides have rated.
      expect((await reportIt(s.runner)).status).toBe(404);
      await rate(s.runner, 5).expect(201);

      const res = await reportIt(s.runner).expect(201);

      expect(res.body.data).toMatchObject({ targetType: 'RATING', type: 'ABUSE' });
      expect(await prisma.report.findUniqueOrThrow({ where: { id: res.body.data.id } })).toMatchObject({
        ratingId: given.id,
        targetUserId: s.requester.userId,
      });
      expect((await reportIt(s.requester)).status).toBe(404);
    });

    it('limits how many reports one user can have open', async () => {
      const s = await completedScene(app, categoryId);
      await prisma.$executeRaw`
        INSERT INTO config_values (key, value_json, version, effective_from, updated_at)
        VALUES ('REPORT_MAX_OPEN_PER_REPORTER', '2'::jsonb, 1, now() - interval '1 minute', now())`;
      await userReport(s.runner, s.requester.userId).expect(201);
      await userReport(s.runner, s.requester.userId).expect(201);

      const res = await userReport(s.runner, s.requester.userId);

      expect(res.status).toBe(429);
      expect(await prisma.report.count()).toBe(2);
    });
  });

  describe('auto-completion pause (Backend PRD 15.3)', () => {
    it('a report by a party holds a delivered errand, and the errand stays DELIVERED', async () => {
      const s = await delivered();
      expect((await errandRow(s.errandId)).auto_complete_at).not.toBeNull();

      const res = await userReport(s.requester, s.runner.userId, { assignmentId: s.assignmentId, type: 'LOST_ITEM' }).expect(201);

      expect(res.body.data.pausesAutoCompletion).toBe(true);
      expect(await errandRow(s.errandId)).toMatchObject({ status: 'DELIVERED', auto_complete_at: null });
      await prisma.$executeRaw`UPDATE errands SET auto_complete_at = now() - interval '1 minute' WHERE id = ${s.errandId}::uuid`;
      expect(await app.get(ExecutionService).autoCompleteDue()).toBe(0);
      expect((await errandRow(s.errandId)).status).toBe('DELIVERED');
    });

    it('a report by a stranger does not hold anything', async () => {
      const s = await delivered();
      const stranger = await signedInUser(app);

      const res = await report(stranger, { targetType: 'ERRAND', targetId: s.errandId, type: 'SPAM', description: 'Looks spammy.' }).expect(201);

      expect(res.body.data.pausesAutoCompletion).toBe(false);
      expect((await errandRow(s.errandId)).auto_complete_at).not.toBeNull();
    });

    it('a report opened before delivery still holds the window when the runner delivers', async () => {
      const s = await acceptedScene(app, categoryId);
      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
      await executionStep(app, s.runner, s.assignmentId, 'pickup').expect(201);
      await userReport(s.requester, s.runner.userId, { assignmentId: s.assignmentId, type: 'UNSAFE_BEHAVIOR' }).expect(201);

      await executionStep(app, s.runner, s.assignmentId, 'deliver').expect(201);

      expect(await errandRow(s.errandId)).toMatchObject({ status: 'DELIVERED', auto_complete_at: null });
    });

    it('deciding the report restarts a fresh 24 hour window, unless another report still holds it', async () => {
      const s = await delivered();
      const first = (await userReport(s.requester, s.runner.userId, { assignmentId: s.assignmentId }).expect(201)).body.data;
      const second = (await userReport(s.runner, s.requester.userId, { assignmentId: s.assignmentId }).expect(201)).body.data;
      const service = app.get(ReportService);
      const admin = await adminId();

      await service.adminResolve(first.id, { outcome: 'DISMISSED', resolution: 'No grounds.' }, { adminId: admin });
      expect((await errandRow(s.errandId)).auto_complete_at).toBeNull();

      await service.adminResolve(second.id, { outcome: 'DISMISSED', resolution: 'No grounds.' }, { adminId: admin });
      const after = await errandRow(s.errandId);
      expect(after.status).toBe('DELIVERED');
      expect(after.auto_complete_at!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
      expect(after.auto_complete_at!.getTime()).toBeLessThan(Date.now() + 25 * 3_600_000);
    });

    it('a report linked to a dispute does not restart the window on its own', async () => {
      const s = await delivered();
      const filed = (await userReport(s.requester, s.runner.userId, { assignmentId: s.assignmentId }).expect(201)).body.data;
      const dispute = (
        await request(app.getHttpServer())
          .post(`${API}/assignments/${s.assignmentId}/disputes`)
          .set(...bearer(s.requester.accessToken))
          .set('Idempotency-Key', randomUUID())
          .send({ type: 'ITEM_NOT_DELIVERED', claim: 'Not delivered.' })
          .expect(201)
      ).body.data;
      const admin = await adminId();
      await app.get(ReportService).adminLinkToDispute(filed.id, dispute.id, { adminId: admin });

      await app.get(ReportService).adminResolve(filed.id, { outcome: 'UPHELD', resolution: 'Part of the dispute.' }, { adminId: admin });

      expect(await errandRow(s.errandId)).toMatchObject({ status: 'DISPUTED', auto_complete_at: null });
      await app.get(DisputeService).adminResolve(dispute.id, { outcome: 'COMPLETE', notes: 'Delivered.' }, { adminId: admin });
      expect((await errandRow(s.errandId)).status).toBe('COMPLETED');
    });
  });

  describe('decision (admin)', () => {
    it('UPHELD records a valid-report fact for the person reported and tells the reporter', async () => {
      const s = await completedScene(app, categoryId);
      const filed = (await userReport(s.runner, s.requester.userId, { assignmentId: s.assignmentId }).expect(201)).body.data;
      const admin = await adminId();

      const decided = await app.get(ReportService).adminResolve(filed.id, { outcome: 'UPHELD', resolution: 'Confirmed with chat log.' }, { adminId: admin });

      expect(decided).toMatchObject({ status: 'RESOLVED', outcome: 'UPHELD', resolvedBy: admin, retentionHold: false });
      const fact = await prisma.reliabilityEvent.findFirstOrThrow({ where: { eventType: 'VALID_REPORT_UPHELD' } });
      expect(fact).toMatchObject({ userId: s.requester.userId, severity: 2, errandId: s.errandId });
      await dispatchOutbox(app);
      const notices = await request(app.getHttpServer()).get(`${API}/notifications`).set(...bearer(s.runner.accessToken)).expect(200);
      expect((notices.body.data as Array<{ type: string }>).map((n) => n.type)).toContain('report.resolved');
      const view = await request(app.getHttpServer()).get(`${API}/reports/${filed.id}`).set(...bearer(s.runner.accessToken)).expect(200);
      expect(view.body.data).toMatchObject({ status: 'RESOLVED', outcome: 'UPHELD' });
      expect(JSON.stringify(view.body.data)).not.toContain('Confirmed with chat log');
    });

    it('DISMISSED records no fact, and a decided report cannot be decided again', async () => {
      const s = await completedScene(app, categoryId);
      const filed = (await userReport(s.runner, s.requester.userId).expect(201)).body.data;
      const service = app.get(ReportService);
      const admin = await adminId();

      await service.adminResolve(filed.id, { outcome: 'DISMISSED', resolution: 'Not supported.' }, { adminId: admin });

      expect(await prisma.reliabilityEvent.count({ where: { eventType: 'VALID_REPORT_UPHELD' } })).toBe(0);
      await expect(service.adminResolve(filed.id, { outcome: 'UPHELD', resolution: 'changed my mind' }, { adminId: admin })).rejects.toMatchObject({
        code: 'ERRAND_INVALID_STATE',
      });
      await expect(service.adminSetStatus(filed.id, 'UNDER_REVIEW', { adminId: admin })).rejects.toMatchObject({ code: 'ERRAND_INVALID_STATE' });
    });

    it('moves through review states and keeps the first response time', async () => {
      const s = await completedScene(app, categoryId);
      const filed = (await userReport(s.runner, s.requester.userId).expect(201)).body.data;
      const service = app.get(ReportService);
      const admin = await adminId();

      const reviewing = await service.adminSetStatus(filed.id, 'UNDER_REVIEW', { adminId: admin });
      const needsAction = await service.adminSetStatus(filed.id, 'ACTION_REQUIRED', { adminId: admin });

      expect(reviewing.status).toBe('UNDER_REVIEW');
      expect(reviewing.firstResponseAt).not.toBeNull();
      expect(needsAction.status).toBe('ACTION_REQUIRED');
      expect(needsAction.firstResponseAt!.getTime()).toBe(reviewing.firstResponseAt!.getTime());
    });
  });

  describe('account deletion', () => {
    it('is blocked for both sides while a report is open', async () => {
      const s = await completedScene(app, categoryId);
      const filed = (await userReport(s.runner, s.requester.userId).expect(201)).body.data;
      const del = (user: Authed) =>
        request(app.getHttpServer()).post(`${API}/me/delete-request`).set(...bearer(user.accessToken)).send({ reason: 'leaving' });

      for (const user of [s.runner, s.requester]) {
        const blocked = await del(user);
        expect(blocked.status).toBe(409);
        expect(JSON.stringify(blocked.body.error.details)).toContain('OPEN_REPORT');
      }
      await app.get(ReportService).adminResolve(filed.id, { outcome: 'DISMISSED', resolution: 'Closed.' }, { adminId: await adminId() });
      expect(JSON.stringify((await del(s.requester)).body)).not.toContain('OPEN_REPORT');
    });
  });

  describe('schema', () => {
    it('refuses a report with no target, one about oneself, and any deletion', async () => {
      const s = await completedScene(app, categoryId);
      await expect(
        prisma.report.create({
          data: { reporterId: s.runner.userId, targetType: 'USER', type: 'OTHER', description: 'no target user' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.report.create({
          data: { reporterId: s.runner.userId, targetType: 'USER', targetUserId: s.runner.userId, type: 'OTHER', description: 'self' },
        }),
      ).rejects.toThrow();
      const filed = (await userReport(s.runner, s.requester.userId).expect(201)).body.data;
      await expect(prisma.$executeRaw`DELETE FROM reports WHERE id = ${filed.id}::uuid`).rejects.toThrow();
    });
  });
});

/**
 * P11-04: disputes, reports, no-shows, ratings and messages. Resolving a dispute applies the outcome
 * through the state machine and tells both parties; sensitive reads need their own permission.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, adminLogin, bearer, createAdmin, seedAdminRoles, seedPolicies, type TestAdmin } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { acceptedScene, completedScene, executionStep } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Admin API: disputes, reports, ratings, messages (P11-04)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categories: Record<string, string>;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    await seedAdminRoles();
    categories = await seedCategories();
  });
  afterAll(async () => {
    await app.close();
  });

  const as = (admin: TestAdmin) => ({
    get: (path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(admin.accessToken as string)),
    post: (path: string, body: Record<string, unknown> = {}) =>
      request(app.getHttpServer()).post(`${API}${path}`).set(...bearer(admin.accessToken as string)).send(body),
  });
  const login = async (role: string) => adminLogin(app, await createAdmin(app, { roles: [role] }));
  const reason = { reasonCode: 'POLICY_VIOLATION', reasonText: 'Test reason' };
  const userPost = (token: string, path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`${API}${path}`).set(...bearer(token)).set('Idempotency-Key', randomUUID()).send(body);
  const statusOf = async (errandId: string) =>
    (await prisma.$queryRaw<Array<{ status: string }>>`SELECT status::text FROM errands WHERE id = ${errandId}::uuid`)[0].status;

  async function disputedScene() {
    const s = await acceptedScene(app, categories.delivery);
    await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
    const opened = await userPost(s.requester.accessToken, `/assignments/${s.assignmentId}/disputes`, {
      type: 'ITEM_NOT_DELIVERED',
      claim: 'The runner never arrived.',
    }).expect(201);
    return { ...s, disputeId: opened.body.data.id as string };
  }

  describe('disputes', () => {
    it('lists the queue, shows the case workspace, and keeps chat behind its own permission', async () => {
      const support = as(await login('SUPPORT_AGENT'));
      const trust = as(await login('TRUST_AND_SAFETY'));
      const root = as(await login('SUPER_ADMIN'));
      const s = await disputedScene();

      const queue = (await support.get('/admin/disputes').expect(200)).body.data;
      expect(queue.map((d: { id: string }) => d.id)).toEqual([s.disputeId]);
      const unassigned = (await support.get('/admin/disputes?unassigned=true').expect(200)).body.data;
      expect(unassigned).toHaveLength(1);

      const workspace = (await trust.get(`/admin/disputes/${s.disputeId}`).expect(200)).body.data;
      expect(workspace).toMatchObject({ id: s.disputeId, claim: 'The runner never arrived.', errand: { id: s.errandId } });
      expect(workspace.timeline.map((e: { type: string }) => e.type)).toContain('STARTED');

      await trust.get(`/admin/disputes/${s.disputeId}/chat?reasonCode=POLICY_VIOLATION`).expect(403);
      await root.get(`/admin/disputes/${s.disputeId}/chat`).expect(400);
      await root.get(`/admin/disputes/${s.disputeId}/chat?reasonCode=POLICY_VIOLATION`).expect(200);
      expect(await prisma.auditLog.count({ where: { action: 'admin.sensitive_view', entityId: s.disputeId } })).toBe(1);
    });

    it('assigns, escalates, takes notes and starts the review, each with a reason and permission', async () => {
      const support = as(await login('SUPPORT_AGENT'));
      const trust = as(await login('TRUST_AND_SAFETY'));
      const s = await disputedScene();

      await support.post(`/admin/disputes/${s.disputeId}/start-review`, reason).expect(403);
      const started = await trust.post(`/admin/disputes/${s.disputeId}/start-review`, reason).expect(200);
      expect(started.body.data.status).toBe('UNDER_REVIEW');
      await trust.post(`/admin/disputes/${s.disputeId}/assign`, reason).expect(200);
      await trust.post(`/admin/disputes/${s.disputeId}/escalate`, reason).expect(200);
      await trust.post(`/admin/disputes/${s.disputeId}/notes`, { body: 'Called the runner.' }).expect(201);
      await trust.post(`/admin/disputes/${s.disputeId}/notes`, { body: '   ' }).expect(400);

      const workspace = (await trust.get(`/admin/disputes/${s.disputeId}`).expect(200)).body.data;
      expect(workspace.assignedTo).toBeTruthy();
      expect(workspace.escalatedAt).toBeTruthy();
      expect(workspace.notes).toHaveLength(1);
      expect((await trust.get('/admin/disputes?mine=true').expect(200)).body.data).toHaveLength(1);
    });

    it('resolves through the state machine, notifies both parties, and refuses without notes', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const s = await disputedScene();

      await trust.post(`/admin/disputes/${s.disputeId}/resolve`, { ...reason, outcome: 'CANCEL', notes: '' }).expect(400);
      const res = await trust
        .post(`/admin/disputes/${s.disputeId}/resolve`, { ...reason, outcome: 'CANCEL', notes: 'Runner did not arrive. Cancelled.' })
        .expect(200);

      expect(res.body.data).toMatchObject({ status: 'RESOLVED', resolution: 'CANCEL' });
      expect(await statusOf(s.errandId)).toBe('CANCELLED');
      const history = await prisma.errandStatusHistory.findFirstOrThrow({ where: { errandId: s.errandId, toStatus: 'CANCELLED' } });
      expect(history.actorType).toBe('ADMIN');
      await dispatchOutbox(app, { eventType: ['dispute.resolved'] });
      const told = await prisma.notification.findMany({ where: { type: { contains: 'dispute' } } });
      expect(new Set(told.map((n) => n.userId))).toEqual(new Set([s.requester.userId, s.runner.userId]));
      await trust.post(`/admin/disputes/${s.disputeId}/resolve`, { ...reason, outcome: 'COMPLETE', notes: 'again' }).expect(409);
    });
  });

  describe('reports', () => {
    async function reported() {
      const s = await completedScene(app, categories.delivery);
      const res = await userPost(s.requester.accessToken, '/reports', {
        targetType: 'USER',
        targetId: s.runner.userId,
        type: 'USER_BEHAVIOR',
        description: 'Rude on the phone.',
        assignmentId: s.assignmentId,
      }).expect(201);
      return { ...s, reportId: res.body.data.id as string };
    }

    it('lists the queue, shows a report, moves it through review and resolves it', async () => {
      const support = as(await login('SUPPORT_AGENT'));
      const trust = as(await login('TRUST_AND_SAFETY'));
      const s = await reported();

      const queue = (await support.get('/admin/reports').expect(200)).body.data;
      expect(queue.map((r: { id: string }) => r.id)).toEqual([s.reportId]);
      expect((await support.get(`/admin/reports/${s.reportId}`).expect(200)).body.data).toMatchObject({ id: s.reportId, type: 'USER_BEHAVIOR' });

      const first = await trust.post(`/admin/reports/${s.reportId}/status`, { ...reason, status: 'UNDER_REVIEW' }).expect(200);
      expect(first.body.data.status).toBe('UNDER_REVIEW');
      await trust.post(`/admin/reports/${s.reportId}/assign`, reason).expect(200);
      await trust.post(`/admin/reports/${s.reportId}/notes`, { body: 'Checked the chat.' }).expect(201);
      const done = await trust.post(`/admin/reports/${s.reportId}/resolve`, { ...reason, outcome: 'UPHELD', resolution: 'Warning issued.' }).expect(200);

      expect(done.body.data.status).toBe('RESOLVED');
      await trust.post(`/admin/reports/${s.reportId}/resolve`, { ...reason, outcome: 'DISMISSED', resolution: 'x' }).expect(409);
      const finance = as(await login('FINANCE'));
      await finance.post(`/admin/reports/${s.reportId}/resolve`, { ...reason, outcome: 'UPHELD', resolution: 'x' }).expect(403);
    });

    it('records a ladder fact against the person reported when a report is upheld', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const s = await reported();

      await trust.post(`/admin/reports/${s.reportId}/resolve`, { ...reason, outcome: 'UPHELD', resolution: 'Upheld.' }).expect(200);

      const events = await prisma.reliabilityEvent.findMany({ where: { userId: s.runner.userId, eventType: 'VALID_REPORT_UPHELD' } });
      expect(events).toHaveLength(1);
    });
  });

  describe('no-show reports', () => {
    it('lists contested reports and decides one', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const s = await acceptedScene(app, categories.delivery);
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO no_show_reports (assignment_id, errand_id, reporter_id, accused_id, status, response_due_at, updated_at)
        VALUES (${s.assignmentId}::uuid, ${s.errandId}::uuid, ${s.requester.userId}::uuid, ${s.runner.userId}::uuid,
                'CONTESTED', now() + interval '1 hour', now())
        RETURNING id::text
      `;

      const queue = (await trust.get('/admin/no-shows').expect(200)).body.data;
      expect(queue.map((r: { id: string }) => r.id)).toEqual([rows[0].id]);
      const res = await trust.post(`/admin/no-shows/${rows[0].id}/resolve`, { ...reason, outcome: 'DISMISS' }).expect(200);

      expect(res.body.data.status).toBe('DISMISSED');
      expect((await trust.get('/admin/no-shows').expect(200)).body.data).toHaveLength(0);
    });
  });

  describe('ratings', () => {
    it('lists ratings, hides one so it no longer counts, and restores it', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const support = as(await login('SUPPORT_AGENT'));
      const s = await completedScene(app, categories.delivery);
      const rated = await userPost(s.requester.accessToken, `/assignments/${s.assignmentId}/ratings`, { scores: { overall: 1 }, review: 'Terrible' }).expect(201);
      await userPost(s.runner.accessToken, `/assignments/${s.assignmentId}/ratings`, { scores: { overall: 5 } }).expect(201);
      const ratingId = rated.body.data.id as string;
      const before = await prisma.userStats.findUniqueOrThrow({ where: { userId: s.runner.userId } });
      expect(before.runnerRatingCount).toBe(1);

      const list = (await trust.get('/admin/ratings?q=terrible').expect(200)).body.data;
      expect(list.map((r: { id: string }) => r.id)).toEqual([ratingId]);
      await support.get('/admin/ratings').expect(403);

      await trust.post(`/admin/ratings/${ratingId}/moderate`, { ...reason, status: 'HIDDEN' }).expect(200);
      expect((await prisma.userStats.findUniqueOrThrow({ where: { userId: s.runner.userId } })).runnerRatingCount).toBe(0);
      await trust.post(`/admin/ratings/${ratingId}/moderate`, { ...reason, status: 'PUBLISHED' }).expect(200);
      expect((await prisma.userStats.findUniqueOrThrow({ where: { userId: s.runner.userId } })).runnerRatingCount).toBe(1);
    });
  });

  describe('messages', () => {
    it('shows a conversation only with CHAT_SENSITIVE_VIEW and a reason, and removes a message', async () => {
      const root = as(await login('SUPER_ADMIN'));
      const trust = as(await login('TRUST_AND_SAFETY'));
      const s = await acceptedScene(app, categories.delivery);
      const conversations = await request(app.getHttpServer()).get(`${API}/conversations`).set(...bearer(s.requester.accessToken)).expect(200);
      const conversationId = conversations.body.data[0].id as string;
      const sent = await userPost(s.requester.accessToken, `/conversations/${conversationId}/messages`, { type: 'TEXT', body: 'Please bring it by 5pm' }).expect(201);
      const messageId = sent.body.data.id as string;

      await trust.get(`/admin/conversations/${conversationId}/messages?reasonCode=SAFETY_RISK`).expect(403);
      await root.get(`/admin/conversations/${conversationId}/messages`).expect(400);
      const view = await root.get(`/admin/conversations/${conversationId}/messages?reasonCode=SAFETY_RISK`).expect(200);
      expect(view.body.data[0]).toMatchObject({ id: messageId, body: 'Please bring it by 5pm' });
      expect(await prisma.auditLog.count({ where: { action: 'admin.sensitive_view', entityId: conversationId } })).toBe(1);

      await trust.post(`/admin/messages/${messageId}/remove`, reason).expect(403);
      await root.post(`/admin/messages/${messageId}/remove`, reason).expect(200);
      const row = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
      expect(row.status).toBe('REMOVED');
    });
  });
});

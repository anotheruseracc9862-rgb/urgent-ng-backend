/**
 * P11-07: notifications and operations. A dead-lettered outbox event can be retried from the API;
 * notices are service-critical only; every view and action has its own permission.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, adminLogin, bearer, createAdmin, seedAdminRoles, seedPolicies, signedInUser, type TestAdmin } from '../test/auth.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Admin API: notifications and operations (P11-07)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    await seedAdminRoles();
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
  const reason = { reasonCode: 'ROUTINE_OPERATION', reasonText: 'Test reason' };

  describe('notifications', () => {
    async function failedDelivery() {
      const user = await signedInUser(app);
      const notification = await prisma.notification.create({
        data: { userId: user.userId, category: 'TRANSACTIONAL', type: 'verification.completed', title: 'You are verified', body: 'b', data: {} },
      });
      await prisma.$executeRaw`
        INSERT INTO notification_deliveries (notification_id, channel, status, attempts, last_error, updated_at)
        VALUES (${notification.id}::uuid, 'PUSH'::"NotificationChannel", 'FAILED', 3, 'provider down', now())
      `;
      return { user, notification };
    }

    it('lists the delivery log with filters and refuses without OPS_VIEW', async () => {
      const ops = as(await login('OPERATIONS'));
      const finance = as(await login('FINANCE'));
      const { user } = await failedDelivery();

      const failed = (await ops.get('/admin/notifications/deliveries?status=FAILED').expect(200)).body.data;
      expect(failed).toHaveLength(1);
      expect(failed[0].data).toMatchObject({ channel: 'PUSH', status: 'FAILED', attempts: 3, lastError: 'provider down', userId: user.userId });
      expect((await ops.get('/admin/notifications/deliveries?status=SENT').expect(200)).body.data).toHaveLength(0);
      await finance.get('/admin/notifications/deliveries').expect(403);
    });

    it('resends a failed delivery from zero attempts', async () => {
      const ops = as(await login('OPERATIONS'));
      const { notification } = await failedDelivery();

      const res = await ops.post(`/admin/notifications/${notification.id}/resend`, reason).expect(200);

      expect(res.body.data).toMatchObject({ retried: 1 });
      const row = await prisma.notificationDelivery.findFirstOrThrow({ where: { notificationId: notification.id } });
      expect(row.status).not.toBe('FAILED');
      expect(row.attempts).toBe(1);
      await ops.post('/admin/notifications/00000000-0000-4000-8000-000000000000/resend', reason).expect(404);
    });

    it('sends a service notice to named users, and only a service-critical kind', async () => {
      const ops = as(await login('OPERATIONS'));
      const support = as(await login('SUPPORT_AGENT'));
      const a = await signedInUser(app);
      const b = await signedInUser(app);

      await support.post('/admin/notifications/announcements', { ...reason, kind: 'OUTAGE', message: 'Payments are slow.', audience: 'USERS', userIds: [a.userId] }).expect(403);
      await ops.post('/admin/notifications/announcements', { ...reason, kind: 'PROMOTION', message: 'Big sale on boosts', audience: 'ALL_ACTIVE' }).expect(400);
      await ops.post('/admin/notifications/announcements', { ...reason, kind: 'OUTAGE', message: 'Payments are slow.', audience: 'USERS' }).expect(400);
      const res = await ops
        .post('/admin/notifications/announcements', { ...reason, kind: 'OUTAGE', message: 'Payments are slow today.', audience: 'USERS', userIds: [a.userId, b.userId] })
        .expect(200);

      expect(res.body.data).toMatchObject({ audience: 2, notified: 2 });
      const notices = await prisma.notification.findMany({ where: { type: 'system.announcement' } });
      expect(notices.map((n) => n.userId).sort()).toEqual([a.userId, b.userId].sort());
      expect(notices[0].body).toBe('Payments are slow today.');
    });

    it('reaches every active user for an audience', async () => {
      const ops = as(await login('OPERATIONS'));
      await signedInUser(app);
      await signedInUser(app);

      const res = await ops.post('/admin/notifications/announcements', { ...reason, kind: 'SECURITY', message: 'Reset your password if asked for a code.', audience: 'ALL_ACTIVE' }).expect(200);

      expect(res.body.data.audience).toBe(2);
    });
  });

  describe('outbox, queues and sweepers', () => {
    it('lists dead-lettered events, retries one from the API, and refuses a live one', async () => {
      const ops = as(await login('OPERATIONS'));
      const support = as(await login('SUPPORT_AGENT'));
      const dead = await prisma.outboxEvent.create({
        data: { eventType: 'test.event', aggregateType: 'test', payload: {}, status: 'DEAD_LETTERED', attempts: 10, lastError: 'boom' },
      });
      const live = await prisma.outboxEvent.create({ data: { eventType: 'test.live', aggregateType: 'test', payload: {}, status: 'PENDING' } });

      const list = (await ops.get('/admin/ops/outbox').expect(200)).body.data;
      expect(list.map((e: { id: string }) => e.id)).toEqual([dead.id]);
      expect(list[0].data).toMatchObject({ eventType: 'test.event', lastError: 'boom' });
      const summary = (await ops.get('/admin/ops/outbox/summary').expect(200)).body.data;
      expect(summary).toMatchObject({ DEAD_LETTERED: 1, PENDING: 1 });

      await support.post(`/admin/ops/outbox/${dead.id}/retry`, reason).expect(403);
      await ops.post(`/admin/ops/outbox/${live.id}/retry`, reason).expect(404);
      await ops.post(`/admin/ops/outbox/${dead.id}/retry`, reason).expect(200);

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: dead.id } });
      expect(after).toMatchObject({ status: 'PENDING', attempts: 0 });
      expect((await ops.get('/admin/ops/outbox').expect(200)).body.data).toHaveLength(0);
    });

    it('shows the queues and the sweepers, and marks a silent sweeper stale', async () => {
      const ops = as(await login('OPERATIONS'));
      await prisma.$executeRaw`
        INSERT INTO sweeper_runs (name, last_started_at, last_finished_at, last_processed, runs, updated_at)
        VALUES ('FreshSweeper', now(), now(), 4, 10, now()), ('SilentSweeper', now() - interval '1 hour', now() - interval '1 hour', 0, 3, now())
      `;

      const queues = (await ops.get('/admin/ops/queues').expect(200)).body.data;
      expect(queues.map((q: { name: string }) => q.name)).toEqual(expect.arrayContaining(['notifications', 'billing']));
      const sweepers = (await ops.get('/admin/ops/sweepers').expect(200)).body.data;
      expect(sweepers.find((s: { name: string }) => s.name === 'FreshSweeper')).toMatchObject({ stale: false, lastProcessed: 4, runs: 10 });
      expect(sweepers.find((s: { name: string }) => s.name === 'SilentSweeper')).toMatchObject({ stale: true });
    });
  });

  describe('risk flags and data-subject requests', () => {
    it('lists open risk flags and reviews one', async () => {
      const ops = as(await login('OPERATIONS'));
      const user = await signedInUser(app);
      const flag = await prisma.riskFlag.create({ data: { signal: 'OFFER_SPAM', userId: user.userId, subjectKey: `user:${user.userId}`, details: {} } });

      const open = (await ops.get('/admin/ops/risk-flags').expect(200)).body.data;
      expect(open.map((f: { id: string }) => f.id)).toEqual([flag.id]);
      await ops.post(`/admin/ops/risk-flags/${flag.id}/review`, { ...reason, status: 'DISMISSED' }).expect(200);
      expect((await ops.get('/admin/ops/risk-flags').expect(200)).body.data).toHaveLength(0);
      await ops.post(`/admin/ops/risk-flags/${flag.id}/review`, { ...reason, status: 'REVIEWED' }).expect(409);
    });

    it('tracks a data-subject request to its due date and closes it with a resolution', async () => {
      const root = as(await login('SUPER_ADMIN'));
      const ops = as(await login('OPERATIONS'));
      const user = await signedInUser(app);

      await ops.post('/admin/ops/data-requests', { ...reason, type: 'ACCESS', summary: 'Wants a copy of their data' }).expect(403);
      const created = await root
        .post('/admin/ops/data-requests', { ...reason, type: 'ACCESS', userId: user.userId, summary: 'Wants a copy of their data', dueInDays: 14 })
        .expect(201);
      const id = created.body.data.id as string;

      const open = (await root.get('/admin/ops/data-requests?status=OPEN').expect(200)).body.data;
      expect(open[0].data).toMatchObject({ type: 'ACCESS', overdue: false, userId: user.userId });
      await root.post(`/admin/ops/data-requests/${id}`, { ...reason, status: 'COMPLETED' }).expect(400);
      await root.post(`/admin/ops/data-requests/${id}`, { ...reason, status: 'IN_PROGRESS' }).expect(200);
      const done = await root.post(`/admin/ops/data-requests/${id}`, { ...reason, status: 'COMPLETED', resolution: 'Export sent by email.' }).expect(200);

      expect(done.body.data.status).toBe('COMPLETED');
      await root.post(`/admin/ops/data-requests/${id}`, { ...reason, status: 'REJECTED', resolution: 'x' }).expect(409);
    });
  });
});

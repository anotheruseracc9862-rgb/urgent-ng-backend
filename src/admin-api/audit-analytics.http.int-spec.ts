/**
 * P11-08: audit search and export, and analytics. The metrics are checked against numbers worked
 * out by hand from the data the test creates.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, adminLogin, bearer, createAdmin, seedAdminRoles, seedPolicies, signedInUser, type TestAdmin } from '../test/auth.helper.js';
import { insertErrand, seedCategories } from '../test/errand.helper.js';
import { completedScene, offerScene } from '../test/assignment.helper.js';
import { readyRunner } from '../test/verification.helper.js';
import { PAYMENT_PROVIDER } from '../common/providers/payment.provider.js';
import type { FakePaymentProvider } from '../common/providers/fakes/payment.fake.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Admin API: audit and analytics (P11-08)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categoryId: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    await seedAdminRoles();
    categoryId = (await seedCategories()).delivery;
    app.get<FakePaymentProvider>(PAYMENT_PROVIDER).reset();
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

  describe('audit', () => {
    it('searches by action prefix, actor and entity, and shows admin sign-ins', async () => {
      const ops = as(await login('OPERATIONS'));
      const trust = as(await login('TRUST_AND_SAFETY'));
      const user = await signedInUser(app);
      await trust.post(`/admin/users/${user.userId}/deactivate`, { reasonCode: 'POLICY_VIOLATION', reasonText: 'x' }).expect(200);

      const byAction = (await ops.get('/admin/audit?action=admin.user.').expect(200)).body.data;
      expect(byAction).toHaveLength(1);
      expect(byAction[0]).toMatchObject({ action: 'admin.user.deactivate', actorType: 'ADMIN', entityId: user.userId, reasonCode: 'POLICY_VIOLATION' });
      const byEntity = (await ops.get(`/admin/audit?entityId=${user.userId}&entityType=user`).expect(200)).body.data;
      expect(byEntity.length).toBeGreaterThan(0);
      const future = new Date(Date.now() + 86_400_000).toISOString();
      expect((await ops.get(`/admin/audit?from=${encodeURIComponent(future)}`).expect(200)).body.data).toHaveLength(0);
      const events = (await ops.get('/admin/audit/auth-events').expect(200)).body.data;
      expect(events.length).toBeGreaterThan(0);
      await request(app.getHttpServer()).get(`${API}/admin/audit`).expect(401);
    });

    it('exports only with AUDIT_EXPORT, and the export itself is recorded', async () => {
      const ops = as(await login('OPERATIONS'));
      const root = as(await login('SUPER_ADMIN'));
      await signedInUser(app);

      await ops.get('/admin/audit/export.csv').expect(403);
      const res = await root.get('/admin/audit/export.csv').expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text.split('\r\n')[0]).toBe('"id","at","actorType","actorId","action","entityType","entityId","reasonCode","requestId"');
      expect(await prisma.auditLog.count({ where: { action: 'admin.audit.export' } })).toBe(1);
    });
  });

  describe('analytics', () => {
    /** One requester with five errands: three with offers (10, 20 and 30 minutes in), one completed, one expired, one with none. */
    async function seed() {
      const requester = await signedInUser(app);
      const a = await offerScene(app, categoryId, { requester });
      const b = await offerScene(app, categoryId, { requester });
      const done = await completedScene(app, categoryId, { requester });
      const none = await insertErrand({ requesterId: requester.userId, categoryId });
      const expired = await insertErrand({ requesterId: requester.userId, categoryId, status: 'EXPIRED' });
      for (const id of [a.errandId, b.errandId, done.errandId, none, expired]) {
        await prisma.$executeRaw`UPDATE errands SET published_at = now() - interval '1 hour' WHERE id = ${id}::uuid`;
      }
      const at = async (errandId: string, minutes: number) =>
        prisma.$executeRaw`
          UPDATE offers SET created_at = (SELECT published_at FROM errands WHERE id = ${errandId}::uuid) + make_interval(mins => ${minutes}::int)
          WHERE errand_id = ${errandId}::uuid
        `;
      await at(a.errandId, 10);
      await at(done.errandId, 20);
      await at(b.errandId, 30);
      return { requester, a, b, done };
    }

    it('computes the headline metrics from the data', async () => {
      const ops = as(await login('OPERATIONS'));
      await seed();

      const o = (await ops.get('/admin/analytics/overview?days=7').expect(200)).body.data;

      expect(o).toMatchObject({
        errandsPublished: 5,
        errandsWithOffer: 3,
        shareReceivingOffer: 0.6,
        minutesToFirstOfferMedian: 20,
        minutesToFirstOfferP90: 28,
        errandsCompleted: 1,
        completionRate: 0.5,
        requestersWithCompleted: 1,
        repeatRequesterShare: 0,
      });
    });

    it('counts demand and the supply near it by pickup area', async () => {
      const ops = as(await login('OPERATIONS'));
      await seed();

      const rows = (await ops.get('/admin/analytics/supply-demand?days=7').expect(200)).body.data;

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ area: 'Yaba', errands: 5, errandsWithOffer: 3, errandsCompleted: 1, offers: 3, availableRunnersWithin5km: 3 });
      expect(rows[0].errandsPerRunner).toBeCloseTo(5 / 3, 1);
    });

    it('counts the funnel for runners and requesters', async () => {
      const ops = as(await login('OPERATIONS'));
      await seed();

      const f = (await ops.get('/admin/analytics/funnel?days=7').expect(200)).body.data;

      expect(f.all).toMatchObject({ registered: 4, contactVerified: 4 });
      expect(f.runners).toMatchObject({ profile: 3, verified: 3, firstOffer: 3, firstJobDone: 1 });
      expect(f.requesters).toMatchObject({ posted: 1, gotOffer: 1, completed: 1 });
    });

    it('sums what was sold, by product and by day', async () => {
      const finance = as(await login('FINANCE'));
      for (const p of [
        { code: 'RUNNER_PRO', name: 'Runner Pro', type: 'RUNNER_PRO', kobo: 500_000 },
        { code: 'VERIFICATION_FEE', name: 'Fee', type: 'VERIFICATION_FEE', kobo: 0 },
        { code: 'PRIORITY_BOOST', name: 'Boost', type: 'PRIORITY_BOOST', kobo: 100_000 },
      ]) {
        const row = await prisma.$queryRaw<Array<{ id: string }>>`
          INSERT INTO commercial_products (code, name, type) VALUES (${p.code}, ${p.name}, ${p.type}) RETURNING id::text`;
        await prisma.$executeRaw`
          INSERT INTO price_versions (product_id, amount_kobo, currency, effective_from) VALUES (${row[0].id}::uuid, ${p.kobo}, 'NGN', now() - interval '1 day')`;
      }
      const runner = await readyRunner(app);
      const order = (
        await request(app.getHttpServer())
          .post(`${API}/billing/orders`)
          .set(...bearer(runner.accessToken))
          .set('Idempotency-Key', randomUUID())
          .send({ type: 'RUNNER_PRO' })
          .expect(201)
      ).body.data;
      app.get<FakePaymentProvider>(PAYMENT_PROVIDER).markPaid(order.payment.reference);
      await request(app.getHttpServer())
        .post(`${API}/billing/orders/${order.id}/verify`)
        .set(...bearer(runner.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(200);

      const r = (await finance.get('/admin/analytics/revenue?days=7').expect(200)).body.data;

      expect(r.totalGrossMinor).toBe(500_000);
      expect(r.streams).toEqual([{ type: 'RUNNER_PRO', orders: 1, grossMinor: 500_000, refundedMinor: 0, netMinor: 500_000 }]);
      expect(r.daily).toHaveLength(1);
    });

    it('exports a report only with ANALYTICS_EXPORT, and refuses a bad window', async () => {
      const finance = as(await login('FINANCE'));
      const root = as(await login('SUPER_ADMIN'));
      const support = as(await login('SUPPORT_AGENT'));
      await seed();

      await support.get('/admin/analytics/overview').expect(403);
      await finance.get('/admin/analytics/export.csv?report=funnel').expect(403);
      const csv = await root.get('/admin/analytics/export.csv?report=funnel&days=7').expect(200);
      expect(csv.text.split('\r\n')[0]).toBe('"group","step","users"');
      expect(csv.text).toContain('"requesters","completed","1"');
      await root.get('/admin/analytics/overview?days=0').expect(400);
      await root.get('/admin/analytics/export.csv?report=secrets').expect(400);
      expect(await prisma.auditLog.count({ where: { action: 'admin.analytics.export' } })).toBe(1);
    });
  });
});

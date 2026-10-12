/**
 * P11-06: pricing, configuration, kill switches and reference data. High-impact values need a
 * second admin; a price change leaves old orders at the price they were made at.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, REQUIRED_CONSENTS, adminLogin, bearer, createAdmin, nextPhone, seedAdminRoles, seedPolicies, signedInUser, type TestAdmin } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { readyRunner } from '../test/verification.helper.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { PAYMENT_PROVIDER } from '../common/providers/payment.provider.js';
import type { FakePaymentProvider } from '../common/providers/fakes/payment.fake.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Admin API: pricing, config, flags, reference data (P11-06)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    await seedAdminRoles();
    await seedCategories();
    app.get<FakePaymentProvider>(PAYMENT_PROVIDER).reset();
  });
  afterAll(async () => {
    await app.close();
  });

  const as = (admin: TestAdmin) => ({
    get: (path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(admin.accessToken as string)),
    post: (path: string, body: Record<string, unknown> = {}) =>
      request(app.getHttpServer()).post(`${API}${path}`).set(...bearer(admin.accessToken as string)).send(body),
    put: (path: string, body: Record<string, unknown> = {}) =>
      request(app.getHttpServer()).put(`${API}${path}`).set(...bearer(admin.accessToken as string)).send(body),
    patch: (path: string, body: Record<string, unknown> = {}) =>
      request(app.getHttpServer()).patch(`${API}${path}`).set(...bearer(admin.accessToken as string)).send(body),
    del: (path: string, body: Record<string, unknown> = {}) =>
      request(app.getHttpServer()).delete(`${API}${path}`).set(...bearer(admin.accessToken as string)).send(body),
  });
  const login = async (role: string) => adminLogin(app, await createAdmin(app, { roles: [role] }));
  const reason = { reasonCode: 'ROUTINE_OPERATION', reasonText: 'Test reason' };

  describe('configuration', () => {
    it('lists values with their group, default and whether a second admin is needed', async () => {
      const ops = as(await login('OPERATIONS'));
      const support = as(await login('SUPPORT_AGENT'));

      const rows = (await ops.get('/admin/config').expect(200)).body.data;
      const limit = rows.find((r: { key: string }) => r.key === 'FREE_RUNNER_DAILY_OFFER_LIMIT');
      expect(limit).toMatchObject({ value: 10, default: 10, overridden: false, needsSecondAdmin: true, type: 'number' });
      expect(rows.find((r: { key: string }) => r.key === 'MAX_ERRAND_PHOTOS')).toMatchObject({ needsSecondAdmin: false });
      await support.get('/admin/config').expect(403);
    });

    it('applies an ordinary value at once, with a type check, and records the history', async () => {
      const ops = as(await login('OPERATIONS'));
      const support = as(await login('SUPPORT_AGENT'));

      await support.put('/admin/config/MAX_ERRAND_PHOTOS', { ...reason, value: 4 }).expect(403);
      await ops.put('/admin/config/MAX_ERRAND_PHOTOS', { ...reason, value: 'four' }).expect(400);
      await ops.put('/admin/config/NOT_A_KEY', { ...reason, value: 1 }).expect(404);
      await ops.put('/admin/config/MAX_ERRAND_PHOTOS', { reasonCode: 'OTHER', value: 4 }).expect(400);
      const res = await ops.put('/admin/config/MAX_ERRAND_PHOTOS', { ...reason, value: 4 }).expect(200);

      expect(res.body.data).toMatchObject({ approvalRequired: false, value: 4 });
      expect(await app.get(BusinessConfigService).get('MAX_ERRAND_PHOTOS')).toBe(4);
      const history = (await ops.get('/admin/config/MAX_ERRAND_PHOTOS/history').expect(200)).body.data;
      expect(history[0]).toMatchObject({ value: 4 });
    });

    it('makes a high-impact value wait for a second admin, then applies it', async () => {
      const first = as(await login('OPERATIONS'));
      const second = as(await login('SUPER_ADMIN'));
      const config = app.get(BusinessConfigService);

      const asked = await first.put('/admin/config/FREE_RUNNER_DAILY_OFFER_LIMIT', { ...reason, value: 12 }).expect(200);
      expect(asked.body.data).toMatchObject({ approvalRequired: true, approval: { status: 'PENDING', kind: 'CONFIG_CHANGE' } });
      expect(await config.get('FREE_RUNNER_DAILY_OFFER_LIMIT')).toBe(10);

      await first.post(`/admin/approvals/${asked.body.data.approval.id}/approve`, {}).expect(403);
      const done = await second.post(`/admin/approvals/${asked.body.data.approval.id}/approve`, {}).expect(200);

      expect(done.body.data.status).toBe('EXECUTED');
      expect(await config.get('FREE_RUNNER_DAILY_OFFER_LIMIT')).toBe(12);
    });
  });

  describe('kill switches', () => {
    it('turns registrations off only after a second admin approves, and registrations are then refused', async () => {
      const ops = as(await login('OPERATIONS'));
      const root = as(await login('SUPER_ADMIN'));

      const flags = (await ops.get('/admin/flags').expect(200)).body.data;
      expect(flags.map((f: { key: string }) => f.key)).toContain('FEATURE_REGISTRATIONS_ENABLED');
      const asked = await ops.put('/admin/flags/FEATURE_REGISTRATIONS_ENABLED', { ...reason, enabled: false }).expect(200);
      expect(asked.body.data.approval.kind).toBe('KILL_SWITCH');
      await request(app.getHttpServer())
        .post(`${API}/auth/register`)
        .send({ name: 'Ada Obi', phone: nextPhone(), password: 'Str0ng-passw0rd!', consents: REQUIRED_CONSENTS })
        .expect(201);

      await root.post(`/admin/approvals/${asked.body.data.approval.id}/approve`, {}).expect(200);
      const refused = await request(app.getHttpServer())
        .post(`${API}/auth/register`)
        .send({ name: 'Bayo Ade', phone: nextPhone(), password: 'Str0ng-passw0rd!', consents: REQUIRED_CONSENTS })
        .expect(503);
      expect(refused.body.error.code).toBe('FEATURE_DISABLED');
      await ops.put('/admin/flags/MAX_ERRAND_PHOTOS', { ...reason, enabled: true }).expect(404);
    });
  });

  describe('pricing', () => {
    async function product() {
      const row = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type) VALUES ('RUNNER_PRO', 'Runner Pro', 'RUNNER_PRO') RETURNING id::text`;
      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, currency, effective_from)
        VALUES (${row[0].id}::uuid, 500000, 'NGN', now() - interval '1 day')`;
      return row[0].id;
    }

    it('schedules a price through a second admin; a new order uses it and an old order keeps its own', async () => {
      const finance = as(await login('FINANCE'));
      const root = as(await login('SUPER_ADMIN'));
      const productId = await product();
      const runner = await readyRunner(app);
      const buy = () =>
        request(app.getHttpServer())
          .post(`${API}/billing/orders`)
          .set(...bearer(runner.accessToken))
          .set('Idempotency-Key', randomUUID())
          .send({ type: 'RUNNER_PRO' });
      const before = (await buy().expect(201)).body.data;
      expect(before.amountMinor).toBe(500_000);

      const list = (await finance.get('/admin/pricing/products').expect(200)).body.data;
      expect(list[0]).toMatchObject({ code: 'RUNNER_PRO', currentPriceKobo: 500_000 });
      const asked = await finance.post(`/admin/pricing/products/${productId}/prices`, { ...reason, amountKobo: 700_000, effectiveFrom: new Date(Date.now() + 1500).toISOString() }).expect(200);
      expect(asked.body.data.approval).toMatchObject({ kind: 'PRICE_CHANGE', status: 'PENDING' });
      await finance.post(`/admin/approvals/${asked.body.data.approval.id}/approve`, {}).expect(403);
      const done = await root.post(`/admin/approvals/${asked.body.data.approval.id}/approve`, {}).expect(200);
      expect(done.body.data.status).toBe('EXECUTED');

      await new Promise((resolve) => setTimeout(resolve, 2200));
      const after = (await buy().expect(201)).body.data;
      expect(after.amountMinor).toBe(700_000);
      const old = await prisma.order.findUniqueOrThrow({ where: { id: before.id } });
      expect(Number(old.amountMinor)).toBe(500_000);
      const versions = (await finance.get(`/admin/pricing/products/${productId}/versions`).expect(200)).body.data;
      expect(versions).toHaveLength(2);
    });

    it('refuses a price that starts in the past, and an anonymous caller', async () => {
      const finance = as(await login('FINANCE'));
      const productId = await product();

      await finance
        .post(`/admin/pricing/products/${productId}/prices`, { ...reason, amountKobo: 1, effectiveFrom: new Date(Date.now() - 86_400_000).toISOString() })
        .expect(400);
      await request(app.getHttpServer()).get(`${API}/admin/pricing/products`).expect(401);
    });
  });

  describe('reference data', () => {
    it('creates and updates a category, and the public list follows', async () => {
      const ops = as(await login('OPERATIONS'));
      const support = as(await login('SUPPORT_AGENT'));

      await support.post('/admin/categories', { ...reason, key: 'gardening', name: 'Gardening', requiresPickup: true, requiresDestination: false }).expect(403);
      const created = await ops
        .post('/admin/categories', { ...reason, key: 'gardening', name: 'Gardening', requiresPickup: true, requiresDestination: false, isPopular: true })
        .expect(201);
      await ops.post('/admin/categories', { ...reason, key: 'gardening', name: 'Again', requiresPickup: true, requiresDestination: false }).expect(409);
      await ops.post('/admin/categories', { ...reason, key: 'Bad Key', name: 'x', requiresPickup: true, requiresDestination: false }).expect(400);
      expect((await request(app.getHttpServer()).get(`${API}/reference/popular-categories`).expect(200)).body.data.map((c: { key: string }) => c.key)).toContain('gardening');

      await ops.patch(`/admin/categories/${created.body.data.id}`, { ...reason, active: false }).expect(200);
      expect((await request(app.getHttpServer()).get(`${API}/reference/categories`).expect(200)).body.data.map((c: { key: string }) => c.key)).not.toContain('gardening');
      await ops.patch(`/admin/categories/${created.body.data.id}`, { ...reason, requiresPickup: false }).expect(400);
    });

    it('adds a prohibited item that the public list then shows, and switches it off', async () => {
      const ops = as(await login('OPERATIONS'));

      const created = await ops.post('/admin/prohibited-items', { ...reason, category: 'weapons', keyword: 'Crossbow', policyVersion: '1.0' }).expect(201);
      expect(created.body.data.keyword).toBe('crossbow');
      await ops.post('/admin/prohibited-items', { ...reason, category: 'weapons', keyword: 'crossbow', policyVersion: '1.0' }).expect(409);
      const publicList = (await request(app.getHttpServer()).get(`${API}/reference/prohibited-items`).expect(200)).body.data;
      expect(publicList.map((i: { keyword: string }) => i.keyword)).toContain('crossbow');

      await ops.patch(`/admin/prohibited-items/${created.body.data.id}`, { ...reason, status: 'INACTIVE' }).expect(200);
      const after = (await request(app.getHttpServer()).get(`${API}/reference/prohibited-items`).expect(200)).body.data;
      expect(after.map((i: { keyword: string }) => i.keyword)).not.toContain('crossbow');
    });

    it('publishes a policy that needs re-acceptance, so a user has it outstanding', async () => {
      const ops = as(await login('OPERATIONS'));
      const user = await signedInUser(app);

      await ops.post('/admin/policies', { ...reason, type: 'TERMS_OF_SERVICE', version: '2.0', documentRef: 'policies/terms/2.0', requiresReacceptance: true }).expect(201);
      await ops.post('/admin/policies', { ...reason, type: 'TERMS_OF_SERVICE', version: '2.0', documentRef: 'x' }).expect(409);

      const consents = await request(app.getHttpServer()).get(`${API}/me/consents`).set(...bearer(user.accessToken)).expect(200);
      expect(consents.body.data.outstanding.map((p: { version: string }) => p.version)).toContain('2.0');
      const history = (await ops.get('/admin/policies').expect(200)).body.data;
      expect(history.TERMS_OF_SERVICE.map((p: { version: string }) => p.version)).toEqual(expect.arrayContaining(['1.0', '2.0']));
    });

    it('overrides a notification template within its placeholders, and resets it', async () => {
      const ops = as(await login('OPERATIONS'));

      const list = (await ops.get('/admin/notification-templates').expect(200)).body.data;
      const offer = list.find((t: { key: string }) => t.key === 'offer.new');
      expect(offer).toMatchObject({ overridden: false, placeholders: expect.arrayContaining(['runnerName', 'amount']) });

      await ops.put('/admin/notification-templates/offer.new', { ...reason, title: 'Offer!', body: '{runnerName} says {nope}' }).expect(400);
      const set = await ops.put('/admin/notification-templates/offer.new', { ...reason, title: 'New offer', body: '{runnerName} offered {amount}.' }).expect(200);
      expect(set.body.data).toMatchObject({ overridden: true, body: '{runnerName} offered {amount}.' });
      await ops.put('/admin/notification-templates/verification.completed', { ...reason, title: 't', body: 'b', active: false }).expect(400);
      await ops.put('/admin/notification-templates/not.a.template', { ...reason, title: 't', body: 'b' }).expect(404);

      const reset = await ops.del('/admin/notification-templates/offer.new', reason).expect(200);
      expect(reset.body.data.overridden).toBe(false);
    });

    it('lists the reason codes the platform uses', async () => {
      const ops = as(await login('OPERATIONS'));

      const res = await ops.get('/admin/reference/reasons').expect(200);

      expect(res.body.data.cancellationReasons).toContain('ADMIN_CANCELLED');
    });
  });
});

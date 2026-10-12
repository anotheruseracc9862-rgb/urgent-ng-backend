/**
 * P11-05: billing, subscriptions, boosts, refunds, entitlements and offer limits. A webhook replay
 * from admin is idempotent; a large refund needs a second admin; grants leave a record.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, adminLogin, bearer, createAdmin, seedAdminRoles, seedPolicies, signedInUser, type TestAdmin } from '../test/auth.helper.js';
import { openErrand, seedCategories } from '../test/errand.helper.js';
import { PAYMENT_PROVIDER } from '../common/providers/payment.provider.js';
import { FAKE_VALID_WEBHOOK_SIGNATURE, type FakePaymentProvider } from '../common/providers/fakes/payment.fake.js';
import { readyRunner } from '../test/verification.helper.js';
import { uniqueNin } from '../test/assignment.helper.js';
import { OfferLimitService } from '../entitlements/offer-limit.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Admin API: billing (P11-05)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categoryId: string;
  const gateway = () => app.get<FakePaymentProvider>(PAYMENT_PROVIDER);

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    await seedAdminRoles();
    categoryId = (await seedCategories()).delivery;
    gateway().reset();
    for (const p of [
      { code: 'VERIFICATION_FEE', name: 'Runner Verification', type: 'VERIFICATION_FEE', kobo: 0 },
      { code: 'RUNNER_PRO', name: 'Runner Pro', type: 'RUNNER_PRO', kobo: 500_000 },
      { code: 'PRIORITY_BOOST', name: 'Priority Boost', type: 'PRIORITY_BOOST', kobo: 100_000 },
    ]) {
      const row = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type) VALUES (${p.code}, ${p.name}, ${p.type}) RETURNING id::text`;
      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, currency, effective_from)
        VALUES (${row[0].id}::uuid, ${p.kobo}, 'NGN', now() - interval '1 day')`;
    }
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
  const reason = { reasonCode: 'FINANCE_ADJUSTMENT', reasonText: 'Test reason' };
  const userPost = (token: string, path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`${API}${path}`).set(...bearer(token)).set('Idempotency-Key', randomUUID()).send(body);

  /** A runner who bought Runner Pro, paid at the fake gateway and settled. */
  let ninSeed = 0;
  async function paidPro() {
    ninSeed += 1;
    const runner = await readyRunner(app, uniqueNin(ninSeed));
    const order = (await userPost(runner.accessToken, '/billing/orders', { type: 'RUNNER_PRO' }).expect(201)).body.data;
    gateway().markPaid(order.payment.reference, 'AUTH_x');
    await userPost(runner.accessToken, `/billing/orders/${order.id}/verify`, {}).expect(200);
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    return { runner, order, payment };
  }

  describe('orders, payments and the webhook log', () => {
    it('lists and shows orders and payments, and refuses without BILLING_VIEW', async () => {
      const finance = as(await login('FINANCE'));
      const support = as(await login('SUPPORT_AGENT'));
      const { order, payment } = await paidPro();

      const list = (await finance.get('/admin/orders').expect(200)).body.data;
      expect(list.map((o: { id: string }) => o.id)).toEqual([order.id]);
      expect(list[0].data).toMatchObject({ type: 'RUNNER_PRO', status: 'PAID', amountMinor: 500_000 });
      expect((await finance.get(`/admin/orders?q=${encodeURIComponent(payment.providerReference.slice(0, 8))}`).expect(200)).body.data).toHaveLength(1);
      const detail = (await finance.get(`/admin/orders/${order.id}`).expect(200)).body.data;
      expect(detail.payments[0]).toMatchObject({ reference: payment.providerReference, status: 'SUCCEEDED' });
      expect((await finance.get('/admin/payments?status=SUCCEEDED').expect(200)).body.data).toHaveLength(1);
      await support.get('/admin/orders').expect(403);
    });

    it('replays a stored webhook event idempotently', async () => {
      const finance = as(await login('FINANCE'));
      const runner = await readyRunner(app);
      const order = (await userPost(runner.accessToken, '/billing/orders', { type: 'RUNNER_PRO' }).expect(201)).body.data;
      gateway().markPaid(order.payment.reference);
      const body = JSON.stringify({ event: 'charge.success', data: { reference: order.payment.reference, id: 777 } });
      await request(app.getHttpServer())
        .post(`${API}/webhooks/paystack`)
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', FAKE_VALID_WEBHOOK_SIGNATURE)
        .send(body)
        .expect(200);

      const log = (await finance.get('/admin/webhooks').expect(200)).body.data;
      expect(log).toHaveLength(1);
      expect(log[0].data).toMatchObject({ eventType: 'charge.success', status: 'PROCESSED', reference: order.payment.reference });
      const eventId = log[0].id as string;

      await finance.post(`/admin/webhooks/${eventId}/replay`, {}).expect(400);
      const first = await finance.post(`/admin/webhooks/${eventId}/replay`, reason).expect(200);
      const second = await finance.post(`/admin/webhooks/${eventId}/replay`, reason).expect(200);

      expect(first.body.data.replayed).toBe(true);
      expect(second.body.data.replayed).toBe(true);
      expect(await prisma.entitlement.count({ where: { userId: runner.userId, type: 'RUNNER_PRO' } })).toBe(1);
      expect(await prisma.payment.count({ where: { orderId: order.id, status: 'SUCCEEDED' } })).toBe(1);
    });

    it('runs a reconciliation on request', async () => {
      const finance = as(await login('FINANCE'));

      const res = await finance.post('/admin/billing/reconcile', reason).expect(200);

      expect(res.body.data).toMatchObject({ checked: expect.any(Number) });
    });
  });

  describe('refunds', () => {
    it('refunds a payment under the threshold at once, and a large one waits for a second admin', async () => {
      const first = as(await login('FINANCE'));
      const second = as(await login('FINANCE'));
      const small = await paidPro();

      const done = await first.post(`/admin/payments/${small.payment.id}/refund`, { ...reason, amountMinor: 100_000 }).expect(200);
      expect(done.body.data).toMatchObject({ status: 'COMPLETED', waitingForSecondAdmin: false });

      const big = await paidPro();
      await prisma.$executeRawUnsafe(
        `INSERT INTO config_values (key, value_json, version, effective_from, updated_at) VALUES ('REFUND_FOUR_EYES_THRESHOLD', '100000'::jsonb, 1, now() - interval '1 minute', now())`,
      );
      await app.get(BusinessConfigService).invalidate('REFUND_FOUR_EYES_THRESHOLD');
      const asked = await first.post(`/admin/payments/${big.payment.id}/refund`, reason).expect(200);
      expect(asked.body.data).toMatchObject({ status: 'REQUESTED', waitingForSecondAdmin: true });

      const queue = (await second.get('/admin/refunds').expect(200)).body.data;
      expect(queue.map((r: { id: string }) => r.id)).toEqual([asked.body.data.id]);
      await first.post(`/admin/refunds/${asked.body.data.id}/approve`, reason).expect(409);
      const approved = await second.post(`/admin/refunds/${asked.body.data.id}/approve`, reason).expect(200);

      expect(approved.body.data.status).toBe('COMPLETED');
    });

    it('rejects a waiting refund, and refuses without REFUNDS_APPROVE', async () => {
      const finance = as(await login('FINANCE'));
      const other = as(await login('FINANCE'));
      const support = as(await login('SUPPORT_AGENT'));
      const p = await paidPro();
      await prisma.$executeRawUnsafe(
        `INSERT INTO config_values (key, value_json, version, effective_from, updated_at) VALUES ('REFUND_FOUR_EYES_THRESHOLD', '100000'::jsonb, 1, now() - interval '1 minute', now())`,
      );
      await app.get(BusinessConfigService).invalidate('REFUND_FOUR_EYES_THRESHOLD');

      await support.post(`/admin/payments/${p.payment.id}/refund`, reason).expect(403);
      const asked = await finance.post(`/admin/payments/${p.payment.id}/refund`, reason).expect(200);
      const rejected = await other.post(`/admin/refunds/${asked.body.data.id}/reject`, reason).expect(200);

      expect(rejected.body.data.status).toBe('REJECTED');
    });
  });

  describe('Runner Pro, boosts, entitlements and offer limits', () => {
    it('grants and ends Runner Pro, and the runner gets and loses the benefits', async () => {
      const support = as(await login('SUPPORT_AGENT'));
      const root = as(await login('SUPER_ADMIN'));
      const runner = await signedInUser(app);
      const limits = app.get(OfferLimitService);

      await support.post(`/admin/users/${runner.userId}/pro/grant`, { ...reason, days: 10 }).expect(403);
      const granted = await root.post(`/admin/users/${runner.userId}/pro/grant`, { ...reason, days: 10 }).expect(200);
      expect(granted.body.data.extended).toBe(false);
      expect(await limits.isPro(runner.userId)).toBe(true);
      expect((await root.get(`/admin/users/${runner.userId}/pro`).expect(200)).body.data).toMatchObject({ active: true });

      const again = await root.post(`/admin/users/${runner.userId}/pro/grant`, { ...reason, days: 5 }).expect(200);
      expect(again.body.data.extended).toBe(true);

      await root.post(`/admin/users/${runner.userId}/pro/end`, reason).expect(200);
      expect(await limits.isPro(runner.userId)).toBe(false);
      await root.post(`/admin/users/${runner.userId}/pro/end`, reason).expect(403);
    });

    it('ends and extends a running boost', async () => {
      const root = as(await login('SUPER_ADMIN'));
      const requester = await signedInUser(app);
      const errandId = await openErrand(app, requester, categoryId);
      const order = (await userPost(requester.accessToken, '/boosts', { errandId }).expect(201)).body.data;
      gateway().markPaid(order.payment.reference);
      await userPost(requester.accessToken, `/billing/orders/${order.id}/verify`, {}).expect(200);
      const boost = await prisma.boost.findFirstOrThrow({ where: { errandId } });
      expect(boost.status).toBe('ACTIVE');

      const extended = await root.post(`/admin/boosts/${boost.id}/extend`, { ...reason, hours: 2 }).expect(200);
      expect(new Date(extended.body.data.expiresAt).getTime()).toBeGreaterThanOrEqual(boost.expiresAt!.getTime());
      expect((await root.get('/admin/boosts?status=ACTIVE').expect(200)).body.data).toHaveLength(1);
      const ended = await root.post(`/admin/boosts/${boost.id}/end`, reason).expect(200);

      expect(ended.body.data.status).toBe('EXPIRED');
      await root.post(`/admin/boosts/${boost.id}/end`, reason).expect(409);
    });

    it('grants verification attempts and revokes an entitlement', async () => {
      const root = as(await login('SUPER_ADMIN'));
      const user = await signedInUser(app);

      const granted = await root.post(`/admin/users/${user.userId}/entitlements`, { ...reason, type: 'VERIFICATION_ATTEMPT_ALLOWANCE', quantity: 3 }).expect(200);
      expect(granted.body.data).toMatchObject({ type: 'VERIFICATION_ATTEMPT_ALLOWANCE', quantity: 3, active: true, source: 'ADMIN' });
      await root.post(`/admin/users/${user.userId}/entitlements`, { ...reason, type: 'RUNNER_PRO' }).expect(400);

      const revoked = await root.post(`/admin/entitlements/${granted.body.data.id}/revoke`, reason).expect(200);
      expect(revoked.body.data.active).toBe(false);
      await root.post(`/admin/entitlements/${granted.body.data.id}/revoke`, reason).expect(409);
      expect((await root.get(`/admin/users/${user.userId}/entitlements`).expect(200)).body.data).toHaveLength(1);
    });

    it('shows a runner\'s daily offers and gives some back', async () => {
      const root = as(await login('SUPER_ADMIN'));
      const finance = as(await login('SUPPORT_AGENT'));
      const runner = await readyRunner(app);
      const requester = await signedInUser(app);
      const errandId = await openErrand(app, requester, categoryId);
      await userPost(runner.accessToken, `/errands/${errandId}/offers`, { amountMinor: 50_000, durationMinutes: 30, availabilityConfirmed: true }).expect(201);

      expect((await root.get(`/admin/offer-limits/${runner.userId}`).expect(200)).body.data).toMatchObject({ used: 1 });
      await finance.post(`/admin/offer-limits/${runner.userId}/reset`, reason).expect(403);
      const reset = await root.post(`/admin/offer-limits/${runner.userId}/reset`, reason).expect(200);

      expect(reset.body.data).toMatchObject({ used: 0 });
      await root.post(`/admin/offer-limits/${runner.userId}/reset`, { ...reason, extra: 0 }).expect(400);
    });
  });
});

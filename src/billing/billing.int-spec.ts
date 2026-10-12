/**
 * P10-01 to P10-07: platform billing (Backend PRD 22). Orders, the checkout, webhooks that are
 * only a hint, entitlements, Runner Pro, boosts, the verification fee, refunds and reconciliation.
 * HTTP, real PostgreSQL and Redis, the fake gateway.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { openErrand, seedCategories } from '../test/errand.helper.js';
import { PAYMENT_PROVIDER } from '../common/providers/payment.provider.js';
import { FAKE_VALID_WEBHOOK_SIGNATURE, type FakePaymentProvider } from '../common/providers/fakes/payment.fake.js';
import { OfferLimitService } from '../entitlements/offer-limit.service.js';
import { RefundService } from './refund.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { ProRenewalService } from './pro-renewal.service.js';
import { ProSubscriptionService } from '../subscriptions/pro-subscription.service.js';
import { BoostService } from '../boosts/boost.service.js';
import { readyRunner } from '../test/verification.helper.js';
import { acceptedScene, offerScene, selectRunner } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Platform billing (P10)', () => {
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
    categoryId = (await seedCategories()).delivery;
    gateway().reset();
    await seedProducts();
  });
  afterAll(async () => {
    await app.close();
  });

  type Authed = { accessToken: string; userId: string };

  /** The launch products and prices (the seed script does this in a real database). */
  async function seedProducts() {
    const products = [
      { code: 'VERIFICATION_FEE', name: 'Runner Verification', type: 'VERIFICATION_FEE', kobo: 0 },
      { code: 'RUNNER_PRO', name: 'Runner Pro', type: 'RUNNER_PRO', kobo: 500_000 },
      { code: 'PRIORITY_BOOST', name: 'Priority Boost', type: 'PRIORITY_BOOST', kobo: 100_000 },
    ];
    for (const p of products) {
      const row = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type) VALUES (${p.code}, ${p.name}, ${p.type})
        RETURNING id::text`;
      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, currency, effective_from)
        VALUES (${row[0].id}::uuid, ${p.kobo}, 'NGN', now() - interval '1 day')`;
    }
  }
  /** A new current price for a product, as an admin would set it. */
  const setPrice = async (code: string, kobo: number) => {
    const product = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM commercial_products WHERE code = ${code}`;
    await prisma.$executeRaw`INSERT INTO price_versions (product_id, amount_kobo, currency, effective_from) VALUES (${product[0].id}::uuid, ${kobo}, 'NGN', now())`;
  };
  const setConfig = (key: string, value: unknown) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO config_values (key, value_json, version, effective_from, updated_at) VALUES ($1, $2::jsonb, 1, now() - interval '1 minute', now())`,
      key,
      JSON.stringify(value),
    );
  const post = (user: Authed, path: string, body: Record<string, unknown> = {}, key = randomUUID()) =>
    request(app.getHttpServer()).post(`${API}${path}`).set(...bearer(user.accessToken)).set('Idempotency-Key', key).send(body);
  const get = (user: Authed, path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(user.accessToken));
  const buyPro = (user: Authed, autoRenew = false, key = randomUUID()) => post(user, '/billing/orders', { type: 'RUNNER_PRO', autoRenew }, key);
  const buyBoost = (user: Authed, errandId: string, key = randomUUID()) => post(user, '/boosts', { errandId }, key);
  const webhook = (reference: string, id: number | string = Math.floor(Math.random() * 1e9), signature = FAKE_VALID_WEBHOOK_SIGNATURE) =>
    request(app.getHttpServer())
      .post(`${API}/webhooks/paystack`)
      .set('x-paystack-signature', signature)
      .send({ event: 'charge.success', data: { id, reference, status: 'success' } });
  /** The customer pays at the gateway and the webhook arrives. */
  async function pay(order: { payment: { reference: string } }, authorizationCode = 'AUTH_test') {
    gateway().markPaid(order.payment.reference, authorizationCode);
    return webhook(order.payment.reference);
  }
  const isPro = (userId: string) => app.get(OfferLimitService).isPro(userId);
  const adminId = async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO admins (email, display_name, password_hash, status, updated_at)
      VALUES (${`admin-${randomUUID()}@urgent.ng`}, 'Test Admin', 'x', 'ACTIVE'::"AdminStatus", now())
      RETURNING id::text`;
    return rows[0].id;
  };

  describe('products and orders', () => {
    it('lists the products with VAT-inclusive prices', async () => {
      const user = await signedInUser(app);

      const res = await get(user, '/billing/products').expect(200);

      const pro = res.body.data.find((p: { code: string }) => p.code === 'RUNNER_PRO');
      expect(pro).toMatchObject({ orderType: 'RUNNER_PRO', priceMinor: 500_000, vatMinor: 34_884, currency: 'NGN', periodDays: 30 });
      expect(res.body.data.find((p: { code: string }) => p.code === 'PRIORITY_BOOST')).toMatchObject({ priceMinor: 100_000, vatMinor: 6_977 });
    });

    it('creates an order at the current price, recording the price version, with a checkout', async () => {
      const runner = await readyRunner(app);

      const res = await buyPro(runner).expect(201);

      expect(res.body.data).toMatchObject({ type: 'RUNNER_PRO', status: 'PENDING', amountMinor: 500_000, vatMinor: 34_884, paidAt: null });
      expect(res.body.data.payment).toMatchObject({ status: 'INITIATED' });
      expect(res.body.data.payment.authorizationUrl).toContain('fake-paystack.local');
      const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.data.id } });
      const version = await prisma.$queryRaw<Array<{ amount_kobo: bigint }>>`SELECT amount_kobo FROM price_versions WHERE id = ${order.priceVersionId}::uuid`;
      expect(Number(version[0].amount_kobo)).toBe(500_000);
      expect(gateway().getCalls('initializeTransaction')).toHaveLength(1);
    });

    it('returns the same order for the same key, and creates nothing twice', async () => {
      const runner = await readyRunner(app);
      const key = randomUUID();

      // In parallel, one runs and the other is told the first is in flight; nothing is created twice.
      await Promise.all([buyPro(runner, false, key), buyPro(runner, false, key)]);
      const first = await buyPro(runner, false, key).expect(201);
      const again = await buyPro(runner, false, key).expect(201);

      expect(again.body.data.id).toBe(first.body.data.id);
      expect(await prisma.order.count()).toBe(1);
      expect(await prisma.payment.count()).toBe(1);
    });

    it('keeps an order on the price it was made at when the price changes', async () => {
      const runner = await readyRunner(app);
      const first = (await buyPro(runner).expect(201)).body.data;
      const product = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM commercial_products WHERE code = 'RUNNER_PRO'`;
      await prisma.$executeRaw`INSERT INTO price_versions (product_id, amount_kobo, currency, effective_from) VALUES (${product[0].id}::uuid, 800000, 'NGN', now())`;

      const second = (await buyPro(runner).expect(201)).body.data;

      expect(first.amountMinor).toBe(500_000);
      expect(second.amountMinor).toBe(800_000);
      expect((await get(runner, `/billing/orders/${first.id}`).expect(200)).body.data.amountMinor).toBe(500_000);
    });

    it('is closed to other users and refuses what it should', async () => {
      const runner = await readyRunner(app);
      const other = await signedInUser(app);
      const order = (await buyPro(runner).expect(201)).body.data;

      expect((await get(other, `/billing/orders/${order.id}`)).status).toBe(404);
      expect((await buyPro(other)).status).toBe(409); // no runner profile
      expect((await post(runner, '/billing/orders', { type: 'VERIFICATION_FEE' })).status).toBe(400); // no fee at launch
      expect((await post(runner, '/billing/orders', { type: 'BOOST' })).status).toBe(400);
      expect((await post(runner, '/billing/orders', { type: 'GOLD' })).status).toBe(400);
    });

    it('answers 503 when the gateway is down, and the same key tries again', async () => {
      const runner = await readyRunner(app);
      const key = randomUUID();
      // A scripted outcome of undefined makes the fake return nothing: that is a failed checkout.
      gateway().scriptOutcomes('initializeTransaction', [undefined]);

      const failed = await buyPro(runner, false, key);

      expect(failed.status).toBe(503);
      expect(failed.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      const retried = await buyPro(runner, false, key).expect(201);
      expect(retried.body.data.payment.authorizationUrl).toContain('fake-paystack.local');
      expect(await prisma.order.count()).toBe(1);
    });

    it('can be switched off, and reading still works', async () => {
      const runner = await readyRunner(app);
      await setConfig('FEATURE_BILLING_ENABLED', false);

      const res = await buyPro(runner);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('FEATURE_DISABLED');
      expect((await get(runner, '/billing/products')).status).toBe(200);
    });
  });

  describe('webhooks (Backend PRD 22.2)', () => {
    it('refuses a bad signature, records it, and grants nothing', async () => {
      const runner = await readyRunner(app);
      const order = (await buyPro(runner).expect(201)).body.data;
      gateway().markPaid(order.payment.reference);

      const res = await webhook(order.payment.reference, 7, 'not-the-signature');

      expect(res.status).toBe(403);
      const stored = await prisma.webhookEvent.findFirstOrThrow();
      expect(stored).toMatchObject({ signatureValid: false, processingStatus: 'FAILED', failureReason: 'INVALID_SIGNATURE' });
      expect(await isPro(runner.userId)).toBe(false);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING');
    });

    it('settles a paid order once: the entitlement, the status, the audit and the receipt', async () => {
      const runner = await readyRunner(app);
      const order = (await buyPro(runner, true).expect(201)).body.data;

      const res = await pay(order).then((r) => r);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ received: true, result: 'processed' });
      const paid = (await get(runner, `/billing/orders/${order.id}`).expect(200)).body.data;
      expect(paid).toMatchObject({ status: 'PAID', payment: { status: 'SUCCEEDED', authorizationUrl: null } });
      expect(await isPro(runner.userId)).toBe(true);
      const sub = await prisma.subscription.findFirstOrThrow({ where: { userId: runner.userId } });
      expect(sub).toMatchObject({ status: 'ACTIVE', autoRenew: true });
      expect(sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime()).toBe(30 * 86_400_000);
      expect(await prisma.entitlement.count({ where: { userId: runner.userId, type: 'RUNNER_PRO' } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'order.paid', entityId: order.id } })).toBe(1);
      // The saved card authorisation is stored encrypted, never plain.
      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      expect(payment.authorizationCode).toBeTruthy();
      expect(payment.authorizationCode).not.toContain('AUTH_test');
    });

    it('acknowledges a duplicate without a second grant', async () => {
      const runner = await readyRunner(app);
      const order = (await buyPro(runner).expect(201)).body.data;
      gateway().markPaid(order.payment.reference);

      const first = await webhook(order.payment.reference, 4242);
      const again = await webhook(order.payment.reference, 4242);
      const third = await webhook(order.payment.reference, 4242);

      expect(first.body.data.result).toBe('processed');
      expect(again.status).toBe(200);
      expect(again.body.data.result).toBe('duplicate');
      expect(third.body.data.result).toBe('duplicate');
      expect(await prisma.entitlement.count({ where: { userId: runner.userId } })).toBe(1);
      expect(await prisma.subscription.count({ where: { userId: runner.userId } })).toBe(1);
      expect((await prisma.webhookEvent.findFirstOrThrow()).duplicateCount).toBe(2);
      expect(await prisma.outboxEvent.count({ where: { eventType: 'order.paid' } })).toBe(1);
    });

    it('settles once even when two different webhooks race for the same payment', async () => {
      const runner = await readyRunner(app);
      const order = (await buyPro(runner).expect(201)).body.data;
      gateway().markPaid(order.payment.reference);

      await Promise.all([webhook(order.payment.reference, 1), webhook(order.payment.reference, 2), webhook(order.payment.reference, 3)]);

      expect(await prisma.entitlement.count({ where: { userId: runner.userId } })).toBe(1);
      expect(await prisma.outboxEvent.count({ where: { eventType: 'order.paid' } })).toBe(1);
    });

    it('does not believe a webhook the gateway does not confirm', async () => {
      const runner = await readyRunner(app);
      const order = (await buyPro(runner).expect(201)).body.data;
      // The webhook says success, but the customer never paid.

      const res = await webhook(order.payment.reference);

      expect(res.status).toBe(200);
      expect(await isPro(runner.userId)).toBe(false);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING');
    });

    it('refuses to grant when the amount paid is not the amount asked, and flags it', async () => {
      const runner = await readyRunner(app);
      const order = (await buyPro(runner).expect(201)).body.data;
      gateway().scriptOutcomes('verifyTransaction', [{ status: 'success', reference: order.payment.reference, amountKobo: 100 }]);

      await webhook(order.payment.reference);

      expect(await isPro(runner.userId)).toBe(false);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('FAILED');
      const flag = await prisma.riskFlag.findFirstOrThrow({ where: { signal: 'PAYMENT_ANOMALY' } });
      expect(flag.details).toMatchObject({ reason: 'AMOUNT_MISMATCH', expectedKobo: 500_000, receivedKobo: 100 });
    });

    it('lets the customer ask "check my payment", which asks the gateway too', async () => {
      const runner = await readyRunner(app);
      const order = (await buyPro(runner).expect(201)).body.data;
      const unpaid = await post(runner, `/billing/orders/${order.id}/verify`).expect(200);
      expect(unpaid.body.data.status).toBe('PENDING');

      gateway().markPaid(order.payment.reference);
      const paid = await post(runner, `/billing/orders/${order.id}/verify`).expect(200);
      const again = await post(runner, `/billing/orders/${order.id}/verify`).expect(200);

      expect(paid.body.data.status).toBe('PAID');
      expect(again.body.data.status).toBe('PAID');
      expect(await prisma.entitlement.count({ where: { userId: runner.userId } })).toBe(1);
    });

    it('closes an order the gateway reports as failed', async () => {
      const runner = await readyRunner(app);
      const order = (await buyPro(runner).expect(201)).body.data;
      gateway().markFailed(order.payment.reference);

      await webhook(order.payment.reference);

      expect((await get(runner, `/billing/orders/${order.id}`).expect(200)).body.data).toMatchObject({ status: 'FAILED', payment: { status: 'FAILED' } });
    });
  });

  describe('Runner Pro (Backend PRD 22.4)', () => {
    it('lifts the offer limit while it lasts, and not a moment after', async () => {
      const runner = await readyRunner(app);
      expect(await isPro(runner.userId)).toBe(false);
      await pay((await buyPro(runner).expect(201)).body.data);
      expect(await isPro(runner.userId)).toBe(true);

      await prisma.$executeRaw`UPDATE entitlements SET valid_from = now() - interval '2 days', valid_until = now() - interval '1 second' WHERE user_id = ${runner.userId}::uuid`;

      expect(await isPro(runner.userId)).toBe(false);
      const view = (await get(runner, '/subscriptions/pro').expect(200)).body.data;
      expect(view).toMatchObject({ active: false, status: 'ACTIVE' });
    });

    it('extends a running period when bought again, keeping the time already paid for', async () => {
      const runner = await readyRunner(app);
      await pay((await buyPro(runner).expect(201)).body.data);
      const first = await prisma.subscription.findFirstOrThrow({ where: { userId: runner.userId } });

      await pay((await buyPro(runner).expect(201)).body.data);

      const after = await prisma.subscription.findFirstOrThrow({ where: { userId: runner.userId } });
      expect(await prisma.subscription.count({ where: { userId: runner.userId } })).toBe(1);
      expect(after.currentPeriodEnd.getTime()).toBe(first.currentPeriodEnd.getTime() + 30 * 86_400_000);
      expect(await prisma.entitlement.count({ where: { userId: runner.userId, type: 'RUNNER_PRO' } })).toBe(2);
    });

    it('cancelling stops renewal but keeps the benefits to the end of the period', async () => {
      const runner = await readyRunner(app);
      await pay((await buyPro(runner, true).expect(201)).body.data);

      const view = (await post(runner, '/subscriptions/pro/cancel').expect(200)).body.data;

      expect(view).toMatchObject({ status: 'CANCELLED', autoRenew: false, active: true });
      expect(view.cancelledAt).toBeTruthy();
      expect(await isPro(runner.userId)).toBe(true);
      expect((await post(await signedInUser(app), '/subscriptions/pro/cancel')).status).toBe(403);
    });

    it('renews with the saved card at the end of the period', async () => {
      const runner = await readyRunner(app);
      await pay((await buyPro(runner, true).expect(201)).body.data, 'AUTH_renew');
      await prisma.$executeRaw`
        UPDATE subscriptions SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 minute'
        WHERE user_id = ${runner.userId}::uuid`;

      const attempted = await app.get(ProRenewalService).renewDue();

      expect(attempted).toBe(1);
      const sub = await prisma.subscription.findFirstOrThrow({ where: { userId: runner.userId } });
      expect(sub.status).toBe('ACTIVE');
      expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
      expect(gateway().getCalls('chargeAuthorization')).toHaveLength(1);
      expect(gateway().getCalls('chargeAuthorization')[0].args[0]).toMatchObject({ authorizationCode: 'AUTH_renew', amountKobo: 500_000 });
      expect(await prisma.order.count({ where: { userId: runner.userId, type: 'RUNNER_PRO', status: 'PAID' } })).toBe(2);
      // A second sweep the same day charges nothing more.
      expect(await app.get(ProRenewalService).renewDue()).toBe(0);
    });

    it('a failed renewal enters the grace days with benefits, retries, and expires', async () => {
      const runner = await readyRunner(app);
      await pay((await buyPro(runner, true).expect(201)).body.data);
      await prisma.$executeRaw`
        UPDATE subscriptions SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 minute'
        WHERE user_id = ${runner.userId}::uuid`;
      await prisma.$executeRaw`UPDATE entitlements SET valid_from = now() - interval '2 days', valid_until = now() - interval '1 minute' WHERE user_id = ${runner.userId}::uuid`;
      gateway().scriptOutcomes('chargeAuthorization', [{ status: 'failed', reference: 'x', amountKobo: 0 }]);

      await app.get(ProRenewalService).renewDue();

      const sub = await prisma.subscription.findFirstOrThrow({ where: { userId: runner.userId } });
      expect(sub.status).toBe('GRACE_PERIOD');
      expect(sub.graceEndsAt).not.toBeNull();
      // Benefits continue through the grace days.
      expect(await isPro(runner.userId)).toBe(true);
      expect(await app.get(ProSubscriptionService).expireDue()).toBe(0);

      await prisma.$executeRaw`UPDATE subscriptions SET grace_ends_at = now() - interval '1 minute' WHERE user_id = ${runner.userId}::uuid`;
      await prisma.$executeRaw`UPDATE entitlements SET valid_from = valid_from - interval '10 days', valid_until = valid_until - interval '10 days' WHERE user_id = ${runner.userId}::uuid`;
      expect(await app.get(ProSubscriptionService).expireDue()).toBe(1);

      expect((await prisma.subscription.findFirstOrThrow({ where: { userId: runner.userId } })).status).toBe('EXPIRED');
      expect(await isPro(runner.userId)).toBe(false);
      expect(await prisma.outboxEvent.count({ where: { eventType: 'subscription.expired' } })).toBe(1);
    });

    it('a manual payment during the grace days restores it', async () => {
      const runner = await readyRunner(app);
      await pay((await buyPro(runner, true).expect(201)).body.data);
      await prisma.$executeRaw`
        UPDATE subscriptions SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 minute'
        WHERE user_id = ${runner.userId}::uuid`;
      gateway().scriptOutcomes('chargeAuthorization', [{ status: 'failed', reference: 'x', amountKobo: 0 }]);
      await app.get(ProRenewalService).renewDue();
      expect((await prisma.subscription.findFirstOrThrow({ where: { userId: runner.userId } })).status).toBe('GRACE_PERIOD');

      await pay((await buyPro(runner).expect(201)).body.data);

      const sub = await prisma.subscription.findFirstOrThrow({ where: { userId: runner.userId } });
      expect(sub.status).toBe('ACTIVE');
      expect(sub.graceEndsAt).toBeNull();
    });

    it('expiry never touches an offer that was already submitted', async () => {
      const s = await offerScene(app, categoryId);
      await pay((await buyPro(s.runner).expect(201)).body.data);
      await prisma.$executeRaw`UPDATE entitlements SET valid_from = now() - interval '2 days', valid_until = now() - interval '1 second' WHERE user_id = ${s.runner.userId}::uuid`;

      const offer = await prisma.offer.findUniqueOrThrow({ where: { id: s.offerId } });

      expect(offer.status).toBe('ACTIVE');
    });

    it('gives the Pro badge and the notification head start', async () => {
      const runner = await readyRunner(app);
      await pay((await buyPro(runner).expect(201)).body.data);
      await dispatchOutbox(app, { eventType: 'subscription.activated' });

      const badges = await prisma.userBadge.findMany({ where: { userId: runner.userId, revokedAt: null } });

      expect(badges.map((b) => b.badge)).toContain('PRO');
    });
  });

  describe('boosts (Backend PRD 22.5)', () => {
    async function openEnd(requester: Authed) {
      return openErrand(app, requester as never, categoryId);
    }

    it('activates on payment, pins in the feed and ends when a runner is selected', async () => {
      const requester = await signedInUser(app);
      const errandId = await openEnd(requester);
      const order = (await buyBoost(requester, errandId).expect(201)).body.data;
      expect(order).toMatchObject({ type: 'BOOST', errandId, amountMinor: 100_000 });

      await pay(order);

      const boost = await prisma.boost.findFirstOrThrow({ where: { errandId } });
      expect(boost.status).toBe('ACTIVE');
      const hours = (boost.expiresAt!.getTime() - boost.activatesAt!.getTime()) / 3_600_000;
      expect(hours).toBeLessThanOrEqual(24);
      expect(await app.get(BoostService).activeBoostedErrandIds()).toEqual([errandId]);

      // A runner is selected: the boost ends.
      const runner = await readyRunner(app, '50000031234');
      const offer = (await post(runner, `/errands/${errandId}/offers`, { amountMinor: 50_000, durationMinutes: 30, availabilityConfirmed: true }).expect(201)).body.data;
      await selectRunner(app, requester, errandId, offer.id, offer.version).expect(201);
      await dispatchOutbox(app, { eventType: 'errand.status_changed' });

      expect((await prisma.boost.findFirstOrThrow({ where: { errandId } })).status).toBe('EXPIRED');
      expect(await app.get(BoostService).activeBoostedErrandIds()).toEqual([]);
    });

    it('allows one boost per errand, and only for its owner on an open errand', async () => {
      const requester = await signedInUser(app);
      const errandId = await openEnd(requester);
      const stranger = await signedInUser(app);
      expect((await buyBoost(stranger, errandId)).status).toBe(404);
      await pay((await buyBoost(requester, errandId).expect(201)).body.data);

      const second = await buyBoost(requester, errandId);

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('BOOST_NOT_ELIGIBLE');
      const s = await acceptedScene(app, categoryId);
      const closed = await buyBoost(s.requester, s.errandId);
      expect(closed.status).toBe(409);
      expect(closed.body.error.code).toBe('BOOST_NOT_ELIGIBLE');
    });

    it('is refunded automatically when the errand left OPEN before the payment arrived', async () => {
      const requester = await signedInUser(app);
      const errandId = await openEnd(requester);
      const order = (await buyBoost(requester, errandId).expect(201)).body.data;
      await request(app.getHttpServer()).post(`${API}/errands/${errandId}/cancel`).set(...bearer(requester.accessToken)).send({ reason: 'REQUESTER_CANCELLED' }).expect(200);

      await pay(order);

      const boost = await prisma.boost.findFirstOrThrow({ where: { errandId } });
      expect(boost.status).toBe('REFUNDED');
      const refund = await prisma.refund.findFirstOrThrow();
      expect(refund).toMatchObject({ status: 'COMPLETED', reason: 'AUTO:BOOST_NOT_ACTIVATED', amountMinor: 100_000n });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('REFUNDED');
      expect(gateway().getCalls('refund')).toHaveLength(1);
      // The same trigger again refunds nothing more.
      await app.get(RefundService).requestAutomatic({ paymentId: refund.paymentId, reason: 'AUTO:BOOST_NOT_ACTIVATED' });
      expect(await prisma.refund.count()).toBe(1);
    });

    it('tells nearby runners when an errand is boosted (the second wave)', async () => {
      const requester = await signedInUser(app);
      const errandId = await openEnd(requester);
      const near = await readyRunner(app, '50000041234');
      await dispatchOutbox(app, { eventType: 'errand.published' });
      await pay((await buyBoost(requester, errandId).expect(201)).body.data);

      await dispatchOutbox(app, { eventType: 'boost.activated' });

      const notices = (await get(near, '/notifications').expect(200)).body.data as Array<{ type: string }>;
      expect(notices.filter((n) => n.type === 'errand.nearby')).toHaveLength(1);
    });

    it('expires by time, and the feed stops pinning it at once', async () => {
      const requester = await signedInUser(app);
      const errandId = await openEnd(requester);
      await pay((await buyBoost(requester, errandId).expect(201)).body.data);
      await prisma.$executeRaw`UPDATE boosts SET expires_at = now() - interval '1 minute' WHERE errand_id = ${errandId}::uuid`;

      expect(await app.get(BoostService).activeBoostedErrandIds()).toEqual([]);
      expect(await app.get(BoostService).expireDue()).toBe(1);
      expect((await prisma.boost.findFirstOrThrow({ where: { errandId } })).status).toBe('EXPIRED');
    });
  });

  describe('verification fee (Backend PRD 10.2)', () => {
    it('is skipped at zero, and with a fee blocks the first attempt until paid, granting the attempts once', async () => {
      await setPrice('VERIFICATION_FEE', 50_000);
      const runner = await signedInUser(app);
      const overview = (await get(runner, '/verification').expect(200)).body.data;
      expect(overview).toMatchObject({ feeRequired: true, canStart: false, attemptsRemaining: 0 });

      const order = (await post(runner, '/billing/orders', { type: 'VERIFICATION_FEE' }).expect(201)).body.data;
      expect(order).toMatchObject({ type: 'VERIFICATION_FEE', amountMinor: 50_000 });
      await pay(order);
      await webhook(order.payment.reference, 99);

      const after = (await get(runner, '/verification').expect(200)).body.data;
      expect(after).toMatchObject({ feeRequired: false, attemptsRemaining: 3 });
      expect(await prisma.entitlement.count({ where: { userId: runner.userId, type: 'VERIFICATION_ATTEMPT_ALLOWANCE' } })).toBe(1);
    });
  });

  describe('refunds (Backend PRD 22.6)', () => {
    async function paidPro(price?: number) {
      if (price !== undefined) {
        const product = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM commercial_products WHERE code = 'RUNNER_PRO'`;
        await prisma.$executeRaw`INSERT INTO price_versions (product_id, amount_kobo, currency, effective_from) VALUES (${product[0].id}::uuid, ${price}, 'NGN', now())`;
      }
      const runner = await readyRunner(app, `5${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}1234`);
      const order = (await buyPro(runner).expect(201)).body.data;
      await pay(order);
      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      return { runner, order, payment };
    }

    it('refunds an admin-approved purchase once, immutably, and ends what it granted', async () => {
      const { runner, order, payment } = await paidPro();
      const admin = await adminId();

      const refund = await app.get(RefundService).request({ paymentId: payment.id, reason: 'Duplicate purchase', actor: { type: 'ADMIN', id: admin } });

      expect(refund).toMatchObject({ status: 'COMPLETED', amountMinor: 500_000n, requestedById: admin });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('REFUNDED');
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('REFUNDED');
      expect(await isPro(runner.userId)).toBe(false);
      await expect(prisma.$executeRaw`UPDATE refunds SET reason = 'changed' WHERE id = ${refund.id}::uuid`).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM refunds WHERE id = ${refund.id}::uuid`).rejects.toThrow();
      await expect(app.get(RefundService).request({ paymentId: payment.id, reason: 'again', actor: { type: 'ADMIN', id: admin } })).rejects.toMatchObject({
        code: 'ERRAND_INVALID_STATE',
      });
      expect(gateway().getCalls('refund')).toHaveLength(1);
    });

    it('supports a partial refund, and never more than was paid', async () => {
      const { payment } = await paidPro();
      const admin = await adminId();
      const service = app.get(RefundService);

      const part = await service.request({ paymentId: payment.id, amountMinor: 200_000, reason: 'Goodwill', actor: { type: 'ADMIN', id: admin } });
      expect(part.status).toBe('COMPLETED');
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('PARTIALLY_REFUNDED');

      await expect(service.request({ paymentId: payment.id, amountMinor: 400_000, reason: 'Too much', actor: { type: 'ADMIN', id: admin } })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      const rest = await service.request({ paymentId: payment.id, reason: 'The rest', actor: { type: 'ADMIN', id: admin } });
      expect(rest.amountMinor).toBe(300_000n);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('REFUNDED');
    });

    it('holds a large refund for a second admin, who cannot be the first', async () => {
      const { payment } = await paidPro(2_500_000);
      await setConfig('REFUND_FOUR_EYES_THRESHOLD', 2_000_000);
      const first = await adminId();
      const second = await adminId();
      const service = app.get(RefundService);
      const other = await paidPro(2_500_000);

      const waiting = await service.request({ paymentId: other.payment.id, reason: 'Large', actor: { type: 'ADMIN', id: first } });

      expect(waiting.status).toBe('REQUESTED');
      expect(gateway().getCalls('refund')).toHaveLength(0);
      await expect(service.approve(waiting.id, { adminId: first })).rejects.toMatchObject({ code: 'ERRAND_INVALID_STATE' });
      const done = await service.approve(waiting.id, { adminId: second });
      expect(done).toMatchObject({ status: 'COMPLETED', approvedBy: second });
      expect(gateway().getCalls('refund')).toHaveLength(1);
      void payment;
    });

    it('records a gateway failure without losing the payment', async () => {
      const { payment } = await paidPro();
      gateway().scriptOutcomes('refund', [{ providerRefundRef: 'r1', status: 'failed' }]);

      const refund = await app.get(RefundService).request({ paymentId: payment.id, reason: 'Try', actor: { type: 'ADMIN', id: await adminId() } });

      expect(refund).toMatchObject({ status: 'FAILED', failureReason: 'GATEWAY_REJECTED' });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('SUCCEEDED');
    });

    it('refunds a verification fee when every attempt ended in a provider fault', async () => {
      await setPrice('VERIFICATION_FEE', 50_000);
      const runner = await signedInUser(app);
      const order = (await post(runner, '/billing/orders', { type: 'VERIFICATION_FEE' }).expect(201)).body.data;
      await pay(order);
      for (let i = 0; i < 2; i += 1) {
        await prisma.$executeRaw`
          INSERT INTO verification_attempts (user_id, provider, status, failure_reason, attempt_number, counts_against_allowance, started_at, completed_at, updated_at)
          VALUES (${runner.userId}::uuid, 'fake', 'FAILED'::"VerificationStatus", 'PROVIDER_ERROR'::"VerificationFailureReason", ${i + 1}, FALSE, now(), now(), now())`;
      }
      await prisma.outboxEvent.create({
        data: { eventType: 'verification.failed', aggregateType: 'verification_attempt', aggregateId: randomUUID(), payload: { userId: runner.userId, failureReason: 'PROVIDER_ERROR' } },
      });

      await dispatchOutbox(app, { eventType: 'verification.failed' });

      const refund = await prisma.refund.findFirstOrThrow();
      expect(refund).toMatchObject({ status: 'COMPLETED', reason: 'AUTO:PROVIDER_FAULT', amountMinor: 50_000n });
    });
  });

  describe('reconciliation (Backend PRD 22.2)', () => {
    it('settles a payment whose webhook never arrived, and closes one that was abandoned', async () => {
      const runner = await readyRunner(app);
      const lost = (await buyPro(runner).expect(201)).body.data;
      gateway().markPaid(lost.payment.reference);
      const abandoned = (await buyPro(runner).expect(201)).body.data;
      await prisma.$executeRaw`UPDATE payments SET created_at = now() - interval '2 days'`;

      const report = await app.get(ReconciliationService).run();

      expect(report.recovered).toBe(1);
      expect(report.closed).toBe(1);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: lost.id } })).status).toBe('PAID');
      expect((await prisma.order.findUniqueOrThrow({ where: { id: abandoned.id } })).status).toBe('CANCELLED');
      expect(await isPro(runner.userId)).toBe(true);
    });

    it('flags a payment that is paid here but not at the gateway, and changes nothing', async () => {
      const runner = await readyRunner(app);
      const order = (await buyPro(runner).expect(201)).body.data;
      await pay(order);
      gateway().scriptOutcomes('verifyTransaction', [{ status: 'failed', reference: order.payment.reference, amountKobo: 500_000 }]);

      const report = await app.get(ReconciliationService).run();

      expect(report.anomalies).toBe(1);
      const flag = await prisma.riskFlag.findFirstOrThrow({ where: { signal: 'PAYMENT_ANOMALY' } });
      expect(flag.details).toMatchObject({ reason: 'PAID_HERE_NOT_AT_GATEWAY' });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAID');
    });
  });

  describe('schema', () => {
    it('never deletes money rows and refuses a negative order', async () => {
      const runner = await readyRunner(app);
      const order = (await buyPro(runner).expect(201)).body.data;
      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });

      await expect(prisma.$executeRaw`DELETE FROM orders WHERE id = ${order.id}::uuid`).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM payments WHERE id = ${payment.id}::uuid`).rejects.toThrow();
      await expect(prisma.$executeRaw`UPDATE orders SET amount_minor = -1 WHERE id = ${order.id}::uuid`).rejects.toThrow();
      await expect(
        prisma.$executeRaw`INSERT INTO payments (order_id, provider, provider_reference, amount_minor, updated_at)
                           VALUES (${order.id}::uuid, 'paystack', ${payment.providerReference}, 1, now())`,
      ).rejects.toThrow();
    });
  });
});

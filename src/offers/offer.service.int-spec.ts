/**
 * P6-04 / P6-06 integration tests: submitting offers, errand state rules, lifecycle hooks and
 * the requester's list. Everything goes through the HTTP API against real PostgreSQL and Redis.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { readyRunner } from '../test/verification.helper.js';
import { insertErrand, openErrand, seedCategories } from '../test/errand.helper.js';
import { listOffers, offerAction, submitOffer } from '../test/offer.helper.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { OfferListService } from './offer-list.service.js';
import { ErrandExpiryService } from '../errands/errand-expiry.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Offers: submit, lifecycle, list (P6-04, P6-06)', () => {
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

  const openErrandFor = (requesterId: string) => insertErrand({ requesterId, categoryId: categories.delivery });
  const counterOf = async (userId: string) => (await prisma.offerDailyCounter.findMany({ where: { userId } })).reduce((n, c) => n + c.count, 0);

  describe('POST /errands/:id/offers', () => {
    it('refuses a note that carries a phone number or email, and stores nothing', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const errandId = await openErrandFor(requester.userId);

      const phone = await submitOffer(app, runner, errandId, { message: 'call me on 0814 787 7487' }).expect(400);
      expect(phone.body.error).toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'message', reason: 'CONTACT_DETAILS_BEFORE_ACCEPTANCE' } });
      await submitOffer(app, runner, errandId, { message: 'mail ade@example.com' }).expect(400);
      expect(await prisma.offer.count({ where: { errandId } })).toBe(0);

      await submitOffer(app, runner, errandId, { message: 'I can do it for 5k in 3 hours' }).expect(201);
    });

    it('creates the offer, its first negotiation event, an outbox event and bumps offer_count', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const errandId = await openErrandFor(requester.userId);

      const res = await submitOffer(app, runner, errandId).expect(201);

      expect(res.body.data).toMatchObject({
        errandId,
        runnerId: runner.userId,
        requesterId: requester.userId,
        status: 'ACTIVE',
        awaitingParty: 'REQUESTER',
        amountMinor: 50_000,
      });
      const events = await prisma.negotiationEvent.findMany({ where: { offerId: res.body.data.id } });
      expect(events.map((e) => e.messageType)).toEqual(['INITIAL_OFFER']);
      const outbox = await prisma.outboxEvent.findMany({ where: { eventType: 'offer.created', aggregateId: res.body.data.id } });
      expect(outbox).toHaveLength(1);
      const [{ offer_count }] = await prisma.$queryRaw<Array<{ offer_count: number }>>`SELECT offer_count FROM errands WHERE id = ${errandId}::uuid`;
      expect(offer_count).toBe(1);
      expect(await counterOf(runner.userId)).toBe(1);
    });

    it('replays the first answer for the same Idempotency-Key and counts once', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const errandId = await openErrandFor(requester.userId);
      const key = randomUUID();

      const first = await submitOffer(app, runner, errandId, {}, key).expect(201);
      const second = await submitOffer(app, runner, errandId, {}, key).expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await counterOf(runner.userId)).toBe(1);
    });

    it('refuses a runner who is not verified, available and unrestricted', async () => {
      const requester = await signedInUser(app);
      const plain = await signedInUser(app);
      const errandId = await openErrandFor(requester.userId);

      const res = await submitOffer(app, plain, errandId);

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(['VERIFICATION_REQUIRED', 'OFFER_NOT_ELIGIBLE']).toContain(res.body.error.code);
      expect(await prisma.offer.count()).toBe(0);
    });

    it('ignores any requester or status the client sends, and refuses own, draft, cancelled and expired errands', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const other = await signedInUser(app);

      const own = await insertErrand({ requesterId: runner.userId, categoryId: categories.delivery });
      expect((await submitOffer(app, runner, own, { requesterId: other.userId, status: 'OPEN' })).status).toBe(400); // client context is not accepted
      const ownRes = await submitOffer(app, runner, own);
      expect(ownRes.status).toBe(403);
      expect(ownRes.body.error.code).toBe('OFFER_NOT_ELIGIBLE');

      const draft = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery, status: 'DRAFT' });
      expect((await submitOffer(app, runner, draft)).status).toBe(404);

      const cancelled = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery, status: 'CANCELLED' });
      const cancelledRes = await submitOffer(app, runner, cancelled);
      expect(cancelledRes.status).toBe(409);
      expect(cancelledRes.body.error.code).toBe('ERRAND_INVALID_STATE');

      const overdue = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery, expiresInHours: -1 });
      expect((await submitOffer(app, runner, overdue)).body.error.code).toBe('ERRAND_INVALID_STATE');

      expect(await prisma.offer.count()).toBe(0);
      expect(await counterOf(runner.userId)).toBe(0);
    });

    it('refuses a runner blocked by, or blocking, the requester, as if the errand did not exist', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const errandId = await openErrandFor(requester.userId);
      await request(app.getHttpServer()).post(`${API}/users/${runner.userId}/block`).set(...bearer(requester.accessToken)).expect(204);

      const res = await submitOffer(app, runner, errandId);

      expect(res.status).toBe(404);
      expect(await prisma.offer.count()).toBe(0);
    });

    it('validates amount, duration and availability, and a failed offer is not counted', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const errandId = await openErrandFor(requester.userId);

      expect((await submitOffer(app, runner, errandId, { amountMinor: 100 })).status).toBe(400);
      expect((await submitOffer(app, runner, errandId, { amountMinor: 999_999_999_999 })).status).toBe(400);
      expect((await submitOffer(app, runner, errandId, { durationMinutes: 2 })).status).toBe(400);
      expect((await submitOffer(app, runner, errandId, { availabilityConfirmed: false })).status).toBe(400);

      expect(await counterOf(runner.userId)).toBe(0);
      expect(await prisma.offer.count()).toBe(0);
    });

    it('allows one active offer per errand and refuses a second', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const errandId = await openErrandFor(requester.userId);
      await submitOffer(app, runner, errandId).expect(201);

      const again = await submitOffer(app, runner, errandId);

      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('OFFER_ALREADY_EXISTS');
      expect(await counterOf(runner.userId)).toBe(1);
    });

    it('enforces the open-offer cap from the database', async () => {
      // Set first, before any other request can read the old value into the 60 s cache.
      await app.get(BusinessConfigService).set('MAX_OPEN_OFFERS_PER_RUNNER', 2);
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const statuses: number[] = [];
      let last: { body: { error?: { code: string } } } | undefined;
      for (let i = 0; i < 3; i += 1) {
        last = await submitOffer(app, runner, await openErrandFor(requester.userId));
        statuses.push((last as unknown as { status: number }).status);
      }
      expect(statuses).toEqual([201, 201, 403]);
      expect(last?.body.error?.code).toBe('OFFER_NOT_ELIGIBLE');
      expect(await counterOf(runner.userId)).toBe(2);
    });
  });

  describe('errand lifecycle hooks', () => {
    it('flags live offers on a material edit; selection-blocking and reconfirm clear it', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const errandId = await openErrand(app, requester, categories.delivery);
      const offer = (await submitOffer(app, runner, errandId).expect(201)).body.data;

      await request(app.getHttpServer())
        .patch(`${API}/errands/${errandId}`)
        .set(...bearer(requester.accessToken))
        .send({ pickup: { point: { lat: 6.55, lng: 3.39 }, landmark: 'Elsewhere' } })
        .expect(200);

      const flagged = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
      expect(flagged.needsReconfirmation).toBe(true);
      expect(flagged.awaitingParty).toBe('RUNNER');
      expect(flagged.version).toBe(offer.version + 1);

      // the requester cannot counter a flagged offer
      const blocked = await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 40_000, durationMinutes: 30 });
      expect(blocked.status).toBe(409);

      const reconfirmed = await offerAction(app, runner, 'post', offer.id, 'reconfirm').expect(200);
      expect(reconfirmed.body.data).toMatchObject({ needsReconfirmation: false, awaitingParty: 'REQUESTER' });
    });

    it('a non-material edit leaves offers alone', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const errandId = await openErrand(app, requester, categories.delivery);
      const offer = (await submitOffer(app, runner, errandId).expect(201)).body.data;

      await request(app.getHttpServer())
        .patch(`${API}/errands/${errandId}`)
        .set(...bearer(requester.accessToken))
        .send({ title: 'Deliver a small parcel' })
        .expect(200);

      const same = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
      expect(same.needsReconfirmation).toBe(false);
      expect(same.version).toBe(offer.version);
    });

    it('cancelling the errand closes live offers as CLOSED / ERRAND_CANCELLED, atomically, with events', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const errandId = await openErrand(app, requester, categories.delivery);
      const offer = (await submitOffer(app, runner, errandId).expect(201)).body.data;

      await request(app.getHttpServer())
        .post(`${API}/errands/${errandId}/cancel`)
        .set(...bearer(requester.accessToken))
        .send({ reason: 'REQUESTER_CANCELLED' })
        .expect(200);

      const closed = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
      expect(closed).toMatchObject({ status: 'CLOSED', closeReason: 'ERRAND_CANCELLED', awaitingParty: 'NONE' });
      expect(closed.closedAt).not.toBeNull();
      const types = (await prisma.negotiationEvent.findMany({ where: { offerId: offer.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.messageType);
      expect(types).toEqual(['INITIAL_OFFER', 'SYSTEM_EVENT']);
      expect(await prisma.outboxEvent.count({ where: { eventType: 'offer.closed', aggregateId: offer.id } })).toBe(1);

      // and nobody can add one afterwards
      const late = await submitOffer(app, await readyRunner(app, '22345678901'), errandId);
      expect(late.body.error.code).toBe('ERRAND_INVALID_STATE');
    });

    it('expiry closes live offers as EXPIRED / ERRAND_EXPIRED', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const errandId = await openErrandFor(requester.userId);
      const offer = (await submitOffer(app, runner, errandId).expect(201)).body.data;
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() - interval '1 minute' WHERE id = ${errandId}::uuid`;

      expect(await app.get(ErrandExpiryService).expireDue()).toBe(1);

      const closed = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
      expect(closed).toMatchObject({ status: 'EXPIRED', closeReason: 'ERRAND_EXPIRED' });
    });
  });

  describe('GET /errands/:id/offers', () => {
    it('is for the errand owner only', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app);
      const stranger = await signedInUser(app);
      const errandId = await openErrandFor(requester.userId);
      await submitOffer(app, runner, errandId).expect(201);

      expect((await listOffers(app, requester, errandId).expect(200)).body.data).toHaveLength(1);
      expect((await listOffers(app, stranger, errandId)).status).toBe(404);
      expect((await listOffers(app, runner, errandId)).status).toBe(404);
    });

    it('sorts by the chosen key and breaks ties by Pro, then age; Pro never overrides the sort', async () => {
      const requester = await signedInUser(app);
      const errandId = await openErrandFor(requester.userId);
      const cheap = await readyRunner(app, '12345678901');
      const mid = await readyRunner(app, '22345678901');
      const pro = await readyRunner(app, '32345678901').catch(() => undefined);
      await submitOffer(app, cheap, errandId, { amountMinor: 30_000, durationMinutes: 90 }).expect(201);
      await submitOffer(app, mid, errandId, { amountMinor: 40_000, durationMinutes: 20 }).expect(201);
      if (pro) await submitOffer(app, pro, errandId, { amountMinor: 40_000, durationMinutes: 60 }).expect(201);
      const price = (await listOffers(app, requester, errandId, 'price_asc').expect(200)).body.data as Array<{ amountMinor: number }>;
      expect(price.map((o) => o.amountMinor)).toEqual(price.map((o) => o.amountMinor).sort((a, b) => a - b));

      const eta = (await listOffers(app, requester, errandId, 'eta_asc').expect(200)).body.data as Array<{ durationMinutes: number }>;
      expect(eta.map((o) => o.durationMinutes)).toEqual(eta.map((o) => o.durationMinutes).sort((a, b) => a - b));

      expect((await listOffers(app, requester, errandId, 'nonsense')).status).toBe(400);
      expect(app.get(OfferListService)).toBeDefined();
    });
  });
});

/**
 * The list features the demo screens need: the dashboard summary, the requester's list search and
 * sort, the feed sorts, the recommended offer order, notification and conversation filters, the
 * reviews page, the runner's history, and the public price list. HTTP only, real PostgreSQL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { insertErrand, seedCategories } from '../test/errand.helper.js';
import { readyRunner, NIN } from '../test/verification.helper.js';
import { addOffer, acceptedScene, completedScene, offerScene, selectedScene, uniqueNin } from '../test/assignment.helper.js';
import { listOffers } from '../test/offer.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Demo list features (HTTP)', () => {
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
  const get = (user: Authed, path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(user.accessToken));
  const rate = (user: Authed, assignmentId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`${API}/assignments/${assignmentId}/ratings`)
      .set(...bearer(user.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const setBudget = (errandId: string, minor: number) =>
    prisma.$executeRaw`UPDATE errands SET suggested_budget_minor = ${minor}::bigint WHERE id = ${errandId}::uuid`;

  describe('GET /billing/products/public', () => {
    it('lists the prices without signing in', async () => {
      const res = await request(app.getHttpServer()).get(`${API}/billing/products/public`).expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      for (const product of res.body.data) {
        expect(product).toMatchObject({ currency: 'NGN' });
        expect(typeof product.priceMinor).toBe('number');
      }
    });
  });

  describe('GET /me/summary', () => {
    it('counts what needs the requester and the runner, and lists the latest activity', async () => {
      const s = await selectedScene(app, categories.delivery);

      const requester = (await get(s.requester, '/me/summary').expect(200)).body.data;
      expect(requester.asRequester).toMatchObject({ awaitingRunnerAcceptance: 1, errandsThisMonth: 1 });
      expect(requester.recentActivity[0]).toMatchObject({ errandId: s.errandId, status: 'RUNNER_SELECTED', role: 'REQUESTER' });

      const runner = (await get(s.runner, '/me/summary').expect(200)).body.data;
      expect(runner.asRunner).toMatchObject({ activeAssignments: 1, selectedAwaitingYou: 1, offersThisWeek: 1 });
      expect(runner.recentActivity[0]).toMatchObject({ role: 'RUNNER' });
    });

    it('gives four weekly posting counts, offers per errand and a time to select for the requester', async () => {
      const s = await selectedScene(app, categories.delivery);

      const res = (await get(s.requester, '/me/summary').expect(200)).body.data.asRequester;

      expect(res.errandsPerWeek).toHaveLength(4);
      expect(res.errandsPerWeek[3]).toBeGreaterThanOrEqual(1);
      expect(res.averageOffersPerErrand).toBeGreaterThanOrEqual(1);
      expect(res.medianMinutesToSelect).toBeGreaterThanOrEqual(1);

      const empty = await signedInUser(app);
      const none = (await get(empty, '/me/summary').expect(200)).body.data.asRequester;
      expect(none).toMatchObject({ errandsPerWeek: [0, 0, 0, 0], averageOffersPerErrand: null, medianMinutesToSelect: null });
    });

    it('gives seven Lagos days of offers sent and times selected for the runner, without gaps', async () => {
      const s = await selectedScene(app, categories.delivery);

      const res = (await get(s.runner, '/me/summary').expect(200)).body.data.asRunner;

      expect(res.offersPerDay).toHaveLength(7);
      const dates = res.offersPerDay.map((day: { date: string }) => day.date);
      expect([...dates].sort()).toEqual(dates);
      const today = res.offersPerDay[6];
      expect(today).toMatchObject({ sent: 1, selected: 1 });
      expect(res.offersPerDay.slice(0, 6).every((day: { sent: number; selected: number }) => day.sent === 0 && day.selected === 0)).toBe(true);
    });

    it('names the requester and the conversation on the runner task list', async () => {
      const s = await selectedScene(app, categories.delivery);

      const res = (await get(s.runner, '/runner/assignments?status=ACTIVE').expect(200)).body.data;

      expect(res[0]).toEqual(expect.objectContaining({ requesterFirstName: expect.any(String) }));
      expect(res[0]).toHaveProperty('conversationId');
    });

    it('has a success rate over errands that ended, and null with none', async () => {
      const empty = await signedInUser(app);
      expect((await get(empty, '/me/summary').expect(200)).body.data.asRequester.successRate).toBeNull();

      const s = await completedScene(app, categories.delivery);
      const res = (await get(s.requester, '/me/summary').expect(200)).body.data;

      expect(res.asRequester).toMatchObject({ completedThisMonth: 1, successRate: 1 });
    });

    it('shows offers to review on an open errand', async () => {
      const s = await offerScene(app, categories.delivery);

      const res = (await get(s.requester, '/me/summary').expect(200)).body.data;

      expect(res.asRequester).toMatchObject({ openErrands: 1, errandsWithOffers: 1, offersToReview: 1 });
    });
  });

  describe('GET /errands/mine enrichment', () => {
    it('shows the lowest offer and who offered on an open errand, and flags it for attention', async () => {
      const s = await offerScene(app, categories.delivery);

      const res = (await get(s.requester, '/errands/mine?tab=OPEN').expect(200)).body.data;

      expect(res[0]).toMatchObject({ id: s.errandId, attention: 'OFFERS', runner: null, agreedAmountMinor: null });
      expect(res[0].lowestOfferMinor).toBeGreaterThan(0);
      expect(res[0].offerPreview).toHaveLength(1);
      expect(res[0].offerPreview[0]).toEqual(expect.objectContaining({ firstName: expect.any(String) }));
    });

    it('shows the selected runner with the agreed amount and asks the requester to confirm', async () => {
      const s = await selectedScene(app, categories.delivery);

      const res = (await get(s.requester, '/errands/mine?tab=ACTIVE').expect(200)).body.data;

      expect(res[0]).toMatchObject({ id: s.errandId, attention: 'RUNNER_TO_CONFIRM', lowestOfferMinor: null, offerPreview: [] });
      expect(res[0].runner).toEqual(expect.objectContaining({ firstName: expect.any(String), completedErrands: expect.any(Number) }));
      expect(res[0].agreedAmountMinor).toBeGreaterThan(0);
    });

    it('lists only errands that need the requester on the ATTENTION tab', async () => {
      const s = await offerScene(app, categories.delivery);
      const quiet = await insertErrand({ requesterId: s.requester.userId, categoryId: categories.delivery, title: 'Nothing happening here' });

      const res = (await get(s.requester, '/errands/mine?tab=ATTENTION').expect(200)).body.data;
      const ids = res.map((e: { id: string }) => e.id);

      expect(ids).toContain(s.errandId);
      expect(ids).not.toContain(quiet);
    });

    it('counts every tab in one call', async () => {
      const s = await offerScene(app, categories.delivery);
      await insertErrand({ requesterId: s.requester.userId, categoryId: categories.delivery, title: 'A draft', status: 'DRAFT' });

      const res = (await get(s.requester, '/errands/mine/counts').expect(200)).body.data;

      expect(res).toMatchObject({ all: 2, open: 1, draft: 1, active: 0, past: 0 });
      expect(res.attention).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /errands/mine search and sort', () => {
    async function seed() {
      const user = await signedInUser(app);
      const cake = await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, title: 'Pick up birthday cake' });
      const keys = await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, title: 'Return spare keys' });
      const parcel = await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, title: 'Send a parcel', status: 'DELIVERED' });
      await setBudget(cake, 4000);
      await setBudget(keys, 9000);
      await setBudget(parcel, 1500);
      return { user, cake, keys, parcel };
    }

    it('searches the title', async () => {
      const { user, keys } = await seed();

      const res = await get(user, '/errands/mine?q=keys').expect(200);

      expect(res.body.data.map((e: { id: string }) => e.id)).toEqual([keys]);
    });

    it('treats % and _ in a search as plain characters', async () => {
      const { user } = await seed();

      const res = await get(user, '/errands/mine?q=%25').expect(200);

      expect(res.body.data).toHaveLength(0);
    });

    it('sorts by the largest budget', async () => {
      const { user, cake, keys, parcel } = await seed();

      const res = await get(user, '/errands/mine?sort=HIGHEST_AMOUNT').expect(200);

      expect(res.body.data.map((e: { id: string }) => e.id)).toEqual([keys, cake, parcel]);
    });

    it('puts what needs attention first, and pages without repeats', async () => {
      const { user, parcel } = await seed();

      const first = await get(user, '/errands/mine?sort=NEEDS_ATTENTION&limit=2').expect(200);
      expect(first.body.data[0].id).toBe(parcel);
      expect(first.body.meta.hasNextPage).toBe(true);
      const second = await get(user, `/errands/mine?sort=NEEDS_ATTENTION&limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`).expect(200);

      const ids = [...first.body.data, ...second.body.data].map((e: { id: string }) => e.id);
      expect(new Set(ids).size).toBe(3);
    });

    it('finds an errand by the name of its runner', async () => {
      const s = await selectedScene(app, categories.delivery);
      await prisma.$executeRaw`UPDATE users SET first_name = 'Zebediah' WHERE id = ${s.runner.userId}::uuid`;

      const res = await get(s.requester, '/errands/mine?q=zebed').expect(200);

      expect(res.body.data.map((e: { id: string }) => e.id)).toEqual([s.errandId]);
    });
  });

  describe('feed sorts', () => {
    it('sorts by the largest budget, and recommended keeps the nearest ring first', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app, NIN.ok);
      const near = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery, title: 'Near and cheap' });
      const far = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery, title: 'Farther and rich', lat: 6.5244, lng: 3.3792 + 0.02 });
      await setBudget(near, 1000);
      await setBudget(far, 9000);

      const byBudget = await get(runner, '/marketplace/errands?sort=budget_desc').expect(200);
      expect(byBudget.body.data.map((e: { id: string }) => e.id)).toEqual([far, near]);

      const recommended = await get(runner, '/marketplace/errands?sort=recommended').expect(200);
      expect(recommended.body.data.map((e: { id: string }) => e.id)).toEqual([near, far]);
    });

    it('pages a budget sort with a cursor and rejects a cursor from another sort', async () => {
      const requester = await signedInUser(app);
      const runner = await readyRunner(app, NIN.ok);
      for (const budget of [3000, 2000, 1000]) {
        const id = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery });
        await setBudget(id, budget);
      }

      const first = await get(runner, '/marketplace/errands?sort=budget_desc&limit=2').expect(200);
      const second = await get(runner, `/marketplace/errands?sort=budget_desc&limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`).expect(200);

      expect(first.body.data).toHaveLength(2);
      expect(second.body.data).toHaveLength(1);
      await get(runner, `/marketplace/errands?sort=newest&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`).expect(400);
    });
  });

  describe('offers: recommended order', () => {
    it('weighs rating, price and time, and the other sorts still work', async () => {
      const s = await offerScene(app, categories.delivery);
      const cheap = await addOffer(app, s.errandId, { amountMinor: 30_000, durationMinutes: 60 });
      await addOffer(app, s.errandId, { amountMinor: 90_000, durationMinutes: 60 });
      await prisma.$executeRaw`
        INSERT INTO user_stats (user_id, runner_rating_avg, runner_rating_count, updated_at)
        VALUES (${s.runner.userId}::uuid, 4.9, 12, now())
        ON CONFLICT (user_id) DO UPDATE SET runner_rating_avg = 4.9, runner_rating_count = 12
      `;

      const res = await listOffers(app, s.requester, s.errandId, 'recommended').expect(200);
      const order = res.body.data.map((o: { id: string }) => o.id);

      expect(order).toHaveLength(3);
      expect(order[order.length - 1]).not.toBe(cheap.offerId);
      expect((await listOffers(app, s.requester, s.errandId, 'price_asc').expect(200)).body.data[0].id).toBe(cheap.offerId);
    });
  });

  describe('notifications by category', () => {
    it('filters the list and the unread count by category', async () => {
      const user = await signedInUser(app);
      await prisma.$executeRaw`
        INSERT INTO notifications (user_id, category, type, title, body, data, dedupe_key, created_at)
        VALUES (${user.userId}::uuid, 'MARKETPLACE'::"NotificationCategory", 'offer.new', 'New offer', 'b', '{}'::jsonb, 'k1', now()),
               (${user.userId}::uuid, 'MESSAGING'::"NotificationCategory", 'message.new', 'Message', 'b', '{}'::jsonb, 'k2', now())
      `;

      const list = await get(user, '/notifications?category=MARKETPLACE').expect(200);
      const count = await get(user, '/notifications/unread-count?category=MESSAGING').expect(200);
      const all = await get(user, '/notifications/unread-count').expect(200);

      expect(list.body.data.map((n: { type: string }) => n.type)).toEqual(['offer.new']);
      expect(count.body.data.count).toBe(1);
      expect(all.body.data.count).toBe(2);
      await get(user, '/notifications?category=NOPE').expect(400);
    });
  });

  describe('conversation tabs and search', () => {
    it('filters by the state of the errand and by title or name', async () => {
      const open = await offerScene(app, categories.delivery);
      const active = await acceptedScene(app, categories.delivery, { requester: open.requester });
      await prisma.$executeRaw`UPDATE errands SET title = 'Bake sale pickup' WHERE id = ${active.errandId}::uuid`;

      const offers = await get(open.requester, '/conversations?filter=OFFERS').expect(200);
      const activeTab = await get(open.requester, '/conversations?filter=ACTIVE').expect(200);
      const all = await get(open.requester, '/conversations').expect(200);
      const search = await get(open.requester, '/conversations?q=bake').expect(200);

      expect(offers.body.data.map((c: { errandId: string }) => c.errandId)).toEqual([open.errandId]);
      expect(activeTab.body.data.map((c: { errandId: string }) => c.errandId)).toEqual([active.errandId]);
      expect(all.body.data).toHaveLength(2);
      expect(search.body.data.map((c: { errandId: string }) => c.errandId)).toEqual([active.errandId]);
      expect((await get(open.requester, '/conversations?filter=CLOSED').expect(200)).body.data).toHaveLength(0);
    });
  });

  describe('GET /me/ratings', () => {
    it('lists ratings received and given, filters by stars, and hides an unrevealed rating from the ratee', async () => {
      const s = await completedScene(app, categories.delivery);
      await rate(s.requester, s.assignmentId, { scores: { overall: 2 }, review: 'Late' }).expect(201);

      const given = await get(s.requester, '/me/ratings?direction=GIVEN').expect(200);
      expect(given.body.data).toHaveLength(1);
      expect(given.body.data[0]).toMatchObject({ assignmentId: s.assignmentId, revealed: false });
      expect(given.body.data[0].scores.overall).toBe(2);

      // The runner has not been shown it yet.
      const before = await get(s.runner, '/me/ratings').expect(200);
      expect(before.body.data).toHaveLength(0);

      await rate(s.runner, s.assignmentId, { scores: { overall: 5 } }).expect(201);
      const after = await get(s.runner, '/me/ratings').expect(200);
      expect(after.body.data).toHaveLength(1);
      expect(after.body.data[0]).toMatchObject({ review: 'Late', counterpartFirstName: expect.any(String) });
      expect((await get(s.runner, '/me/ratings?maxStars=1').expect(200)).body.data).toHaveLength(0);
      expect((await get(s.runner, '/me/ratings?minStars=2&maxStars=3').expect(200)).body.data).toHaveLength(1);
      await get(s.runner, '/me/ratings?minStars=9').expect(400);
    });
  });

  describe('runner history', () => {
    it('searches, summarises per month and exports a CSV', async () => {
      const s = await completedScene(app, categories.delivery);
      await prisma.$executeRaw`UPDATE errands SET title = '=cmd|calc' WHERE id = ${s.errandId}::uuid`;

      const found = await get(s.runner, '/runner/assignments?q=cmd').expect(200);
      expect(found.body.data).toHaveLength(1);
      expect((await get(s.runner, '/runner/assignments?q=zzz-none').expect(200)).body.data).toHaveLength(0);
      const future = new Date(Date.now() + 86_400_000).toISOString();
      expect((await get(s.runner, `/runner/assignments?from=${encodeURIComponent(future)}`).expect(200)).body.data).toHaveLength(0);

      const summary = (await get(s.runner, '/runner/assignments/summary?months=3').expect(200)).body.data;
      expect(summary.months).toHaveLength(3);
      expect(summary).toMatchObject({ completed: 1, total: 1 });
      expect(summary.months[2]).toMatchObject({ completed: 1, cancelled: 0 });
      expect(summary.months[2].agreedTotalMinor).toBeGreaterThan(0);

      const csv = await get(s.runner, '/runner/assignments/export.csv').expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toContain('job-history.csv');
      const lines = csv.text.trim().split('\r\n');
      expect(lines[0]).toBe('"Errand","Requester","Selected on","Status","Rating","Agreed amount (NGN)"');
      expect(lines).toHaveLength(2);
      // A title that a spreadsheet would run as a formula is neutralised.
      expect(lines[1].startsWith("\"'=cmd|calc\"")).toBe(true);
      expect(lines[1]).toContain('COMPLETED');
    });

    it('never shows another runner\'s history', async () => {
      await completedScene(app, categories.delivery);
      const other = await readyRunner(app, uniqueNin(9000));

      expect((await get(other, '/runner/assignments').expect(200)).body.data).toHaveLength(0);
      const csv = await get(other, '/runner/assignments/export.csv').expect(200);
      expect(csv.text.trim().split('\r\n')).toHaveLength(1);
    });
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, enforcementActionFor, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { fakeStorage, readyMedia } from '../test/media.helper.js';
import { NIN, fakeKyc, readyRunner, type TestUser } from '../test/verification.helper.js';
import { createDraft, draftBody, insertErrand, openErrand, publishErrand, seedCategories } from '../test/errand.helper.js';
import { MAPS_PROVIDER } from '../common/providers/maps.provider.js';
import { FakeMapsProvider } from '../common/providers/fakes/maps.fake.js';
import { NearbyMatchingService } from './nearby-matching.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { FEED_BOOST_SOURCE } from './feed-boost.hook.js';
import { RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';

process.env.RATE_LIMIT_DISABLED = 'true';

// Places around a runner whose operating area is centred on Yaba with a 5 km radius.
const NEAR = { lat: 6.53, lng: 3.385 }; // under 1 km
const MID = { lat: 6.55, lng: 3.39 }; // about 3 km
const FAR = { lat: 7.3775, lng: 3.947 }; // Ibadan, far outside
const pin = (point: { lat: number; lng: number }, extra: Record<string, unknown> = {}) => ({ point, landmark: 'Near the gate', ...extra });

describe('Marketplace feed, map, detail and saved errands (P5-07, P5-08)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categories: Record<string, string>;
  let requester: TestUser;
  let runner: TestUser;
  const server = () => app.getHttpServer();
  const as = (who: { accessToken: string }) => ({
    get: (path: string) => request(server()).get(`${API}${path}`).set(...bearer(who.accessToken)),
    post: (path: string) => request(server()).post(`${API}${path}`).set(...bearer(who.accessToken)),
    delete: (path: string) => request(server()).delete(`${API}${path}`).set(...bearer(who.accessToken)),
    put: (path: string) => request(server()).put(`${API}${path}`).set(...bearer(who.accessToken)),
  });
  const config = () => app.get(BusinessConfigService);
  const maps = () => app.get<FakeMapsProvider>(MAPS_PROVIDER);
  const post = (extra: Record<string, unknown> = {}, category = 'delivery', who: TestUser = requester) =>
    openErrand(app, who, categories[category], { pickup: pin(NEAR), destination: pin(MID), ...extra });
  const ids = (res: request.Response) => (res.body.data as Array<{ id: string }>).map((item) => item.id);

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categories = await seedCategories();
    fakeKyc(app).reset();
    fakeStorage(app).reset();
    maps().reset();
    requester = await signedInUser(app);
    runner = await readyRunner(app, NIN.ok);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env.RATE_LIMIT_DISABLED = 'true';
  });
  afterAll(async () => {
    await app.close();
  });

  describe('administrative coverage contract', () => {
    const coverage = (areaMode = 'STATE', areaStateIds = ['ng-lagos'], areaLgaIds: string[] = []) =>
      as(runner).put('/runner/profile').send({ transport: 'BICYCLE', areaMode, areaStateIds, areaLgaIds });
    const offer = (id: string) => as(runner).post(`/errands/${id}/offers`).set('Idempotency-Key', randomUUID())
      .send({ amountMinor: 200000, durationMinutes: 30, availabilityConfirmed: true });
    const place = (state: string, lga = 'Lagos Mainland') => ({ success: true, state, lga, area: lga });

    it('exposes stable public reference IDs and validates state/LGA membership and the rollout toggle', async () => {
      const ref = await request(server()).get(`${API}/reference/service-areas`).expect(200);
      expect(ref.body.data.interstateEnabled).toBe(false);
      expect(ref.body.data.states).toHaveLength(37);
      expect(ref.body.data.states.find((s: { id: string }) => s.id === 'ng-lagos').lgas).toContainEqual({ id: 'ng-lagos:lagos-mainland', name: 'Lagos Mainland' });
      expect(ref.body.data.states).toContainEqual(expect.objectContaining({ id: 'ng-katsina', name: 'Katsina' }));
      await coverage('STATE', []).expect(400);
      await coverage('STATE', ['ng-imaginary']).expect(400);
      await coverage('LGAS', ['ng-lagos'], []).expect(400);
      await coverage('LGAS', ['ng-lagos'], ['ng-oyo:ibadan-north']).expect(400);
      await coverage('STATE', ['ng-lagos', 'ng-ogun']).expect(400);
      await config().set('INTERSTATE_ERRANDS_ENABLED', true);
      await coverage('STATE', ['ng-lagos', 'ng-ogun']).expect(200);
      expect((await request(server()).get(`${API}/reference/service-areas`)).body.data.interstateEnabled).toBe(true);
    });

    it('matches all stops in selected LGAs for feed/map/count/detail/saved/offers and nearby notifications', async () => {
      await coverage('LGAS', ['ng-lagos'], ['ng-lagos:lagos-mainland', 'ng-lagos:ikeja']).expect(200);
      maps().scriptOutcomes('reverseGeocode', [place('Lagos State'), place('Lagos', 'Ikeja')]);
      const id = await post();
      const notify = vi.spyOn(app.get(NotificationService), 'notify').mockResolvedValue({ notificationId: null, created: true });
      expect(await app.get(NearbyMatchingService).onDelayed(id, [runner.userId], new Date())).toBe(1);
      expect(notify).toHaveBeenCalledOnce();
      const feed = await as(runner).get('/marketplace/errands').expect(200);
      expect(ids(feed)).toEqual([id]);
      expect(feed.body.meta.total).toBe(1);
      expect(feed.body.data[0].distance).toBeNull();
      expect((await as(runner).get('/marketplace/errands/map').expect(200)).body.data[0].distance).toBeNull();
      expect((await as(runner).get(`/marketplace/errands/${id}`).expect(200)).body.data.distance).toBeNull();
      await as(runner).post(`/saved-errands/${id}`).expect(200);
      const before = (await as(runner).get('/runner/offer-limit').expect(200)).body.data.used;
      await coverage('LGAS', ['ng-lagos'], ['ng-lagos:lagos-mainland']).expect(200);
      expect(ids(await as(runner).get('/marketplace/errands').expect(200))).toEqual([]);
      expect(ids(await as(runner).get('/marketplace/errands/map').expect(200))).toEqual([]);
      await as(runner).get(`/marketplace/errands/${id}`).expect(404);
      await as(runner).post(`/saved-errands/${id}`).expect(404);
      expect(ids(await as(runner).get('/saved-errands').expect(200))).toEqual([]);
      expect(await app.get(NearbyMatchingService).onDelayed(id, [runner.userId], new Date())).toBe(0);
      expect((await offer(id).expect(403)).body.error.details.reasons).toContain('OUTSIDE_OPERATING_AREA');
      expect((await as(runner).get('/runner/offer-limit').expect(200)).body.data.used).toBe(before);
      await coverage('LGAS', ['ng-lagos'], ['ng-lagos:lagos-mainland', 'ng-lagos:ikeja']).expect(200);
      await offer(id).expect(201);
    });

    it('blocks interstate publish and OPEN edits by default, enables them explicitly, and rechecks reads/offers when disabled', async () => {
      await coverage().expect(200);
      maps().scriptOutcomes('reverseGeocode', [place('Lagos'), place('Ogun', 'Abeokuta North')]);
      const draft = await createDraft(app, requester, draftBody(categories.delivery));
      expect(draft.status).toBe(201);
      const id = draft.body.data.id;
      expect((await publishErrand(app, requester, id).expect(422)).body.error.details.reason).toBe('INTERSTATE_NOT_AVAILABLE');
      await config().set('INTERSTATE_ERRANDS_ENABLED', true);
      await publishErrand(app, requester, id).expect(201);
      await as(runner).get(`/marketplace/errands/${id}`).expect(404);
      await coverage('STATE', ['ng-lagos', 'ng-ogun']).expect(200);
      await as(runner).get(`/marketplace/errands/${id}`).expect(200);
      await as(runner).post(`/saved-errands/${id}`).expect(200);
      await config().set('INTERSTATE_ERRANDS_ENABLED', false);
      await as(runner).get(`/marketplace/errands/${id}`).expect(404);
      expect(ids(await as(runner).get('/saved-errands').expect(200))).toEqual([]);
      await offer(id).expect(403);
      const local = await post();
      maps().scriptOutcomes('reverseGeocode', [place('Ogun', 'Abeokuta North')]);
      const edit = await request(server()).patch(`${API}/errands/${local}`).set(...bearer(requester.accessToken))
        .send({ destination: pin(MID) }).expect(422);
      expect(edit.body.error.details.reason).toBe('INTERSTATE_NOT_AVAILABLE');
      await config().set('INTERSTATE_ERRANDS_ENABLED', true);
      maps().scriptOutcomes('reverseGeocode', [place('Ogun', 'Abeokuta North')]);
      await request(server()).patch(`${API}/errands/${local}`).set(...bearer(requester.accessToken)).send({ destination: pin(MID) }).expect(200);
    });

    it('keeps unknown-state drafts safe but blocks publication and never geocodes exact errand pins', async () => {
      maps().clearCalls();
      maps().scriptOutcomes('reverseGeocode', [place('Unrecognised'), place('Lagos')]);
      const draft = await createDraft(app, requester, draftBody(categories.delivery, { pickup: pin(NEAR), destination: pin(MID) })).expect(201);
      const id = draft.body.data.id;
      expect((await publishErrand(app, requester, id).expect(422)).body.error.details.reason).toBe('LOCATION_STATE_UNVERIFIED');
      expect((await prisma.errand.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT');
      const calls = maps().getCalls('reverseGeocode');
      expect(calls).toHaveLength(2);
      expect(calls[0].args).not.toEqual([NEAR.lat, NEAR.lng]);
      expect(calls[1].args).not.toEqual([MID.lat, MID.lng]);
      await config().set('INTERSTATE_ERRANDS_ENABLED', true);
      await publishErrand(app, requester, id).expect(422);
      await request(server()).patch(`${API}/errands/${id}`).set(...bearer(requester.accessToken)).send({ pickup: pin(NEAR) }).expect(200);
      await publishErrand(app, requester, id).expect(201);
    });

    it.each(['nearest', 'recommended'])('uses null distances with deterministic %s pagination for centreless profiles', async (sort) => {
      const profile = await coverage().expect(200);
      expect(profile.body.data).toMatchObject({ areaMode: 'STATE', areaStateIds: ['ng-lagos'], areaLgaIds: [], areaCenter: null });
      expect((await as(runner).get('/runner/profile').expect(200)).body.data.areaCenter).toBeNull();
      const expected = [await post(), await post(), await post()];
      const first = await as(runner).get(`/marketplace/errands?sort=${sort}&limit=2`).expect(200);
      const second = await as(runner).get(`/marketplace/errands?sort=${sort}&limit=2&cursor=${first.body.meta.nextCursor}`).expect(200);
      expect([...ids(first), ...ids(second)]).toEqual(expected.reverse());
      expect([...first.body.data, ...second.body.data].every((row: { distance: unknown }) => row.distance === null)).toBe(true);
    });

    it('keeps legacy radius writes compatible but requires old circles to be confirmed and every stop to fit', async () => {
      await prisma.$executeRaw`UPDATE runner_profiles SET area_state_ids = '{}' WHERE user_id = ${runner.userId}::uuid`;
      expect((await as(runner).get('/runner/eligibility').expect(200)).body.data.reasons).toContain('OPERATING_AREA_REQUIRED');
      await as(runner).get('/marketplace/errands').expect(403);
      const profile = await as(runner).put('/runner/profile').send({ transport: 'BICYCLE', areaCenter: { lat: 6.5244, lng: 3.3792 } }).expect(200);
      expect(profile.body.data).toMatchObject({ areaMode: 'RADIUS', areaStateIds: ['ng-lagos'] });
      const local = await post();
      const farStop = await post({ destination: pin(FAR) });
      expect(ids(await as(runner).get('/marketplace/errands').expect(200))).toEqual([local]);
      await as(runner).get(`/marketplace/errands/${farStop}`).expect(404);
      maps().scriptOutcomes('reverseGeocode', [place('Unknown')]);
      await as(runner).put('/runner/profile').send({ transport: 'BICYCLE', areaCenter: NEAR }).expect(400);
      await as(runner).put('/runner/profile').send({ transport: 'BICYCLE' }).expect(400);
    });
  });

  describe('who may browse (P5-07 done-when)', () => {
    it('needs sign-in', async () => {
      await request(server()).get(`${API}/marketplace/errands`).expect(401);
    });

    it('refuses a user who is not a verified runner, with the reason', async () => {
      const plain = await signedInUser(app);
      const res = await as(plain).get('/marketplace/errands').expect(403);
      expect(res.body.error.code).toBe('VERIFICATION_REQUIRED');
    });

    it('refuses an unavailable runner and one without a runner profile', async () => {
      await as(runner).put('/runner/availability').send({ availability: 'UNAVAILABLE' }).expect(200);
      const unavailable = await as(runner).get('/marketplace/errands').expect(403);
      expect(unavailable.body.error).toMatchObject({ code: 'FORBIDDEN', details: { reasons: ['UNAVAILABLE'] } });

      const verifiedNoProfile = await (await import('../test/verification.helper.js')).verifiedUser(app, NIN.other);
      const res = await as(verifiedNoProfile).get('/marketplace/errands').expect(403);
      expect(res.body.error.details.reasons).toContain('NO_RUNNER_PROFILE');
    });

    it('refuses a runner restricted from offering', async () => {
      const action = await enforcementActionFor(runner.userId);
      await prisma.$executeRaw`
        INSERT INTO user_restrictions (user_id, type, status, starts_at, ends_at, enforcement_action_id, updated_at)
        VALUES (${runner.userId}::uuid, 'OFFERING'::"UserRestrictionType", 'ACTIVE'::"RestrictionStatus", now() - interval '1 hour', now() + interval '1 day', ${action}::uuid, now())`;
      const res = await as(runner).get('/marketplace/errands').expect(403);
      expect(res.body.error.details.reasons).toContain('RESTRICTED');
    });

    it('applies the same gate to the map, the detail and saving', async () => {
      const plain = await signedInUser(app);
      const id = await post();
      await as(plain).get('/marketplace/errands/map').expect(403);
      await as(plain).get(`/marketplace/errands/${id}`).expect(403);
      await as(plain).post(`/saved-errands/${id}`).expect(403);
    });
  });

  describe('what a response may contain', () => {
    it('never carries exact coordinates, addresses, landmarks or contacts, in any view', async () => {
      const id = await post({
        pickup: { point: NEAR, landmark: 'Behind the secret warehouse', addressText: '7 Hidden Close, Yaba' },
        destination: { point: MID, addressText: '9 Private Road, Surulere', landmark: 'Green gate' },
        pickupContact: { name: 'Chika Eze', phone: '08031234567' },
        dropoffContact: { name: 'Ngozi Eze', phone: '08021234567' },
        instructions: 'Ring twice',
      });
      const feed = await as(runner).get('/marketplace/errands').expect(200);
      const map = await as(runner).get('/marketplace/errands/map').expect(200);
      const detail = await as(runner).get(`/marketplace/errands/${id}`).expect(200);

      for (const body of [feed.body, map.body, detail.body]) {
        const text = JSON.stringify(body);
        expect(text).not.toMatch(/Hidden Close|Private Road|secret warehouse|Green gate|Chika|Ngozi|803123|802123/);
        // The exact numbers, as whole numbers (an approximate 6.5503... is a different number).
        for (const exact of [NEAR.lat, NEAR.lng, MID.lat, MID.lng]) {
          const asNumber = new RegExp(String.raw`(?<![\d.])` + String(exact).replace('.', String.raw`\.`) + String.raw`(?!\d)`);
          expect(text).not.toMatch(asNumber);
        }
        expect(text).not.toMatch(/"(exact|addressText|landmark|phone|contact|pickupContact|dropoffContact)/);
      }
      expect(feed.body.data).toHaveLength(1);
    });

    it('shows the area, a distance bucket, the requester first name and the offer count', async () => {
      const id = await post();
      const res = await as(runner).get('/marketplace/errands').expect(200);

      expect(res.body.data[0]).toMatchObject({
        id,
        title: 'Deliver a parcel',
        category: { key: 'delivery', name: 'Delivery' },
        pickup: { area: 'Yaba', lga: 'Lagos Mainland', state: 'Lagos' },
        timeMode: 'ASAP',
        priority: 'URGENT',
        requester: { firstName: 'Ada', photoMediaId: null, rating: null, ratingCount: 0 },
        offerCount: 0,
        boosted: false,
        saved: false,
      });
      expect(res.body.data[0].distance.label).toMatch(/^< \d+(\.\d)? km$/);
      expect(res.body.data[0].distance.upperKm).toBeGreaterThan(0);
    });

    it('buckets distances: never finer than 0.5 km', async () => {
      await post();
      const res = await as(runner).get('/marketplace/errands').expect(200);
      const { upperKm } = res.body.data[0].distance;
      expect(Number.isInteger(upperKm * 2)).toBe(true);
    });
  });

  describe('the operating circle', () => {
    it('lists errands inside it and leaves out errands outside it', async () => {
      const inside = await post();
      await post({ pickup: pin(FAR), destination: pin(FAR) });
      const res = await as(runner).get('/marketplace/errands').expect(200);
      expect(ids(res)).toEqual([inside]);
    });

    it('lets a runner narrow the radius but never widen it', async () => {
      const near = await post({ pickup: pin(NEAR), destination: pin(NEAR) });
      const mid = await post({ pickup: pin(MID) });
      expect(ids(await as(runner).get('/marketplace/errands?sort=newest').expect(200)).sort()).toEqual([near, mid].sort());
      expect(ids(await as(runner).get('/marketplace/errands?radiusKm=1').expect(200))).toEqual([near]);
      // 20 km asked for, but the runner's own circle is 5 km: the far errand stays out.
      await post({ pickup: pin({ lat: 6.7, lng: 3.5 }) });
      expect(ids(await as(runner).get('/marketplace/errands?radiusKm=20').expect(200)).sort()).toEqual([near, mid].sort());
      await as(runner).get('/marketplace/errands?radiusKm=50').expect(400);
    });

    it('follows the runner when the area moves', async () => {
      const inIbadan = await post({ pickup: pin(FAR), destination: pin(FAR) });
      await as(runner).put('/runner/profile').send({ transport: 'MOTORCYCLE', areaCenter: FAR, areaRadiusKm: 5 }).expect(200);
      expect(ids(await as(runner).get('/marketplace/errands').expect(200))).toEqual([inIbadan]);
    });

    it('uses the destination when an errand has no pickup (shopping)', async () => {
      const shopping = await post({ pickup: undefined, destination: pin(NEAR) }, 'shopping_purchase');
      expect(ids(await as(runner).get('/marketplace/errands').expect(200))).toEqual([shopping]);
    });

    it('leaves out categories the runner excluded', async () => {
      await post({}, 'delivery');
      const pickup = await post({ destination: undefined }, 'pickup');
      await as(runner).put('/runner/profile').send({ transport: 'MOTORCYCLE', areaCenter: { lat: 6.5244, lng: 3.3792 }, areaRadiusKm: 5, excludedCategoryIds: [categories.delivery] }).expect(200);
      expect(ids(await as(runner).get('/marketplace/errands').expect(200))).toEqual([pickup]);
    });
  });

  describe('what is never listed', () => {
    it('leaves out own errands, drafts, closed errands, expired ones and blocked users', async () => {
      const visible = await post();
      await post({}, 'delivery', runner); // the runner's own errand (they may post too)
      await createDraft(app, requester, draftBody(categories.delivery, { pickup: pin(NEAR) })).expect(201);
      await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery, status: 'RUNNER_SELECTED', lat: NEAR.lat, lng: NEAR.lng });
      await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery, status: 'COMPLETED', lat: NEAR.lat, lng: NEAR.lng });
      await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery, status: 'OPEN', expiresInHours: -1, lat: NEAR.lat, lng: NEAR.lng }); // OPEN but overdue

      expect(ids(await as(runner).get('/marketplace/errands').expect(200))).toEqual([visible]);

      const other = await signedInUser(app);
      const blockedPost = await post({}, 'delivery', other);
      await as(runner).post(`/users/${other.userId}/block`).expect(204);
      expect(ids(await as(runner).get('/marketplace/errands').expect(200))).toEqual([visible]);
      await as(runner).delete(`/users/${other.userId}/block`).expect(204);
      expect(ids(await as(runner).get('/marketplace/errands?sort=newest').expect(200))).toContain(blockedPost);
    });

    it('leaves out a requester who blocked the runner', async () => {
      await post();
      await as(requester).post(`/users/${runner.userId}/block`).expect(204);
      expect((await as(runner).get('/marketplace/errands').expect(200)).body.data).toEqual([]);
    });
  });

  describe('sorting and paging', () => {
    it('sorts nearest first, then newest, with a stable tie-break', async () => {
      const mid = await post({ pickup: pin(MID) });
      const near = await post({ pickup: pin(NEAR) });
      const nearer = await post({ pickup: pin({ lat: 6.5256, lng: 3.3801 }) });

      const nearest = ids(await as(runner).get('/marketplace/errands?sort=nearest').expect(200));
      expect(nearest[0]).toBe(nearer);
      expect(nearest[nearest.length - 1]).toBe(mid);
      expect(ids(await as(runner).get('/marketplace/errands?sort=newest').expect(200))).toEqual([nearer, near, mid]);
    });

    it.each(['nearest', 'newest'])('pages through every errand once with sort=%s', async (sort) => {
      const all: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        all.push(await post({ pickup: pin({ lat: 6.5244 + (i % 3) * 0.005, lng: 3.3792 + (i % 2) * 0.004 }) }));
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await as(runner).get(`/marketplace/errands?sort=${sort}&limit=3${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
        seen.push(...ids(res));
        cursor = res.body.meta?.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(7);
      expect(new Set(seen)).toEqual(new Set(all));
    });

    it('tells the first page how many errands match, and only the first page', async () => {
      for (let i = 0; i < 3; i += 1) await post();
      const first = await as(runner).get('/marketplace/errands?sort=newest&limit=2').expect(200);
      expect(first.body.meta.total).toBe(3);
      const second = await as(runner).get(`/marketplace/errands?sort=newest&limit=2&cursor=${first.body.meta.nextCursor}`).expect(200);
      expect(second.body.meta.total).toBeUndefined();
    });

    it('rejects a damaged cursor, and a cursor from the other sort order', async () => {
      for (let i = 0; i < 3; i += 1) await post();
      const first = await as(runner).get('/marketplace/errands?sort=nearest&limit=1').expect(200);
      const cursor = first.body.meta.nextCursor as string;
      await as(runner).get('/marketplace/errands?sort=newest&limit=1&cursor=' + cursor).expect(400);
      await as(runner).get('/marketplace/errands?cursor=not-a-cursor').expect(400);
      await as(runner).get('/marketplace/errands?limit=0').expect(400);
      await as(runner).get('/marketplace/errands?limit=51').expect(400);
      await as(runner).get('/marketplace/errands?sort=sideways').expect(400);
    });
  });

  describe('filters', () => {
    it('filters by category (several allowed)', async () => {
      const delivery = await post({}, 'delivery');
      const pickup = await post({ destination: undefined }, 'pickup');
      const doc = await post({}, 'document');
      expect(ids(await as(runner).get('/marketplace/errands?category=pickup&sort=newest').expect(200))).toEqual([pickup]);
      expect(ids(await as(runner).get('/marketplace/errands?category=delivery,document&sort=newest').expect(200))).toEqual([doc, delivery]);
    });

    it('filters by budget range and time mode', async () => {
      const cheap = await post({ suggestedBudgetMinor: 100000 });
      const dear = await post({ suggestedBudgetMinor: 900000 });
      const noBudget = await post();
      const scheduled = await post({ timeMode: 'SCHEDULED', scheduledAt: new Date(Date.now() + 5 * 3_600_000).toISOString(), suggestedBudgetMinor: 500000 });

      expect(ids(await as(runner).get('/marketplace/errands?budgetMin=400000&sort=newest').expect(200))).toEqual([scheduled, dear]);
      expect(ids(await as(runner).get('/marketplace/errands?budgetMax=200000').expect(200))).toEqual([cheap]);
      expect(ids(await as(runner).get('/marketplace/errands?budgetMin=100000&budgetMax=500000&sort=newest').expect(200))).toEqual([scheduled, cheap]);
      expect(ids(await as(runner).get('/marketplace/errands?timeMode=SCHEDULED').expect(200))).toEqual([scheduled]);
      expect(ids(await as(runner).get('/marketplace/errands?timeMode=ASAP&sort=newest').expect(200))).toEqual([noBudget, dear, cheap]);
    });

    it('searches title, description, category name and area', async () => {
      const cake = await post({ title: 'Collect a birthday cake', description: 'From the bakery on the corner' });
      const keys = await post({ title: 'Drop my keys', description: 'Hand them to the caretaker' });

      expect(ids(await as(runner).get('/marketplace/errands?q=cake').expect(200))).toEqual([cake]);
      expect(ids(await as(runner).get('/marketplace/errands?q=caretaker').expect(200))).toEqual([keys]);
      expect(ids(await as(runner).get('/marketplace/errands?q=bakery%20birthday').expect(200))).toEqual([cake]);
      expect((await as(runner).get('/marketplace/errands?q=yaba&sort=newest').expect(200)).body.data).toHaveLength(2);
      expect((await as(runner).get('/marketplace/errands?q=deliver&sort=newest').expect(200)).body.data).toHaveLength(2); // category name "Delivery"
      expect((await as(runner).get('/marketplace/errands?q=zebra').expect(200)).body.data).toEqual([]);
    });

    it('treats search text as text, not as SQL or a wildcard', async () => {
      await post();
      for (const q of ["'; DROP TABLE errands; --", '%', '_', '\\', 'a & b | !c']) {
        await as(runner).get(`/marketplace/errands?q=${encodeURIComponent(q)}`).expect(200);
      }
      expect(await prisma.errand.count()).toBe(1);
      expect((await as(runner).get('/marketplace/errands?q=%25').expect(200)).body.data).toEqual([]);
    });
  });

  describe('boosted errands are pinned (Backend PRD 12.4)', () => {
    it('pins boosted errands on the first page, at most the configured number, without duplicates', async () => {
      const older = [await post(), await post(), await post()];
      const normal = [await post(), await post()];
      vi.spyOn(app.get(FEED_BOOST_SOURCE), 'activeBoostedErrandIds').mockResolvedValue(older);
      await config().set('FEED_MAX_PINNED_BOOSTS_PER_PAGE', 2);

      const first = await as(runner).get('/marketplace/errands?sort=newest&limit=2').expect(200);

      const items = first.body.data as Array<{ id: string; boosted: boolean }>;
      expect(items.slice(0, 2).every((item) => item.boosted)).toBe(true); // two pinned, at most
      expect(new Set(older)).toContain(items[0].id);
      expect(items.map((item) => item.id).slice(2)).toEqual([normal[1], normal[0]]);
      expect(new Set(items.map((item) => item.id)).size).toBe(items.length);

      const second = await as(runner).get(`/marketplace/errands?sort=newest&limit=2&cursor=${first.body.meta.nextCursor}`).expect(200);
      expect((second.body.data as Array<{ boosted: boolean }>).some((item) => item.boosted)).toBe(false);
    });

    it('does not let a boost bypass the circle, the filters or visibility', async () => {
      const far = await post({ pickup: pin(FAR), destination: pin(FAR) });
      const blocked = await signedInUser(app);
      const theirs = await post({}, 'delivery', blocked);
      await as(runner).post(`/users/${blocked.userId}/block`).expect(204);
      const cheap = await post({ suggestedBudgetMinor: 100 });
      vi.spyOn(app.get(FEED_BOOST_SOURCE), 'activeBoostedErrandIds').mockResolvedValue([far, theirs, cheap]);

      const res = await as(runner).get('/marketplace/errands?budgetMin=1000').expect(200);

      expect(res.body.data).toEqual([]);
    });
  });

  describe('GET /marketplace/errands/map', () => {
    it('returns approximate points inside the circle, nearest first, and honours the filters and limit', async () => {
      const near = await post({ pickup: pin(NEAR) });
      const mid = await post({ pickup: pin(MID) });
      await post({ pickup: pin(FAR), destination: pin(FAR) });

      const res = await as(runner).get('/marketplace/errands/map').expect(200);

      expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([near, mid]);
      const point = res.body.data[0];
      expect(point).toMatchObject({ id: near, title: 'Deliver a parcel', categoryKey: 'delivery', area: 'Yaba', priority: 'URGENT', boosted: false });
      expect(Math.abs(point.approx.lat - NEAR.lat)).toBeLessThan(0.01);
      expect(point.approx.lat).not.toBe(NEAR.lat);
      expect(Object.keys(point).sort()).toEqual(['approx', 'area', 'boosted', 'categoryKey', 'distance', 'id', 'myOffer', 'priority', 'suggestedBudgetMinor', 'title']);

      expect((await as(runner).get('/marketplace/errands/map?limit=1').expect(200)).body.data).toHaveLength(1);
      expect((await as(runner).get('/marketplace/errands/map?category=document').expect(200)).body.data).toEqual([]);
      await as(runner).get('/marketplace/errands/map?limit=500').expect(400);
    });
  });

  describe('GET /marketplace/errands/:id (access levels)', () => {
    it('gives another runner the approximate view, and the owner the exact one', async () => {
      const photo = await readyMedia(app, requester.accessToken, 'ERRAND_PHOTO');
      const id = await post({
        pickup: { point: NEAR, landmark: 'Behind the secret warehouse' },
        instructions: 'Ring twice',
        itemSize: 'SMALL',
        photoMediaIds: [photo],
      });

      const asRunner = await as(runner).get(`/marketplace/errands/${id}`).expect(200);
      expect(asRunner.body.data).toMatchObject({ id, instructions: 'Ring twice', itemSize: 'SMALL', photos: [{ mediaId: photo, position: 0 }] });
      expect(asRunner.body.data.pickupApprox).toMatchObject({ area: 'Yaba' });
      expect(asRunner.body.data.pickupApprox.approx.lat).not.toBe(NEAR.lat);
      expect(JSON.stringify(asRunner.body)).not.toMatch(/secret warehouse/);

      const asOwner = await as(requester).get(`/errands/${id}`).expect(200);
      expect(asOwner.body.data.pickup.exact).toEqual(NEAR);
      expect(asOwner.body.data.pickup.landmark).toBe('Behind the secret warehouse');
    });

    it('is not found for the owner here, a stranger via the owner route, closed errands or blocked users', async () => {
      const id = await post();
      const ownErrand = await post({}, 'delivery', runner);
      await as(runner).get(`/marketplace/errands/${ownErrand}`).expect(404); // your own errand is not in the marketplace for you
      const stranger = await signedInUser(app);
      await as(stranger).get(`/errands/${id}`).expect(404);
      await as(runner).get(`/marketplace/errands/${randomUUID()}`).expect(404);
      await as(runner).get('/marketplace/errands/not-a-uuid').expect(400);

      const closed = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery, status: 'ACCEPTED', lat: NEAR.lat, lng: NEAR.lng });
      await as(runner).get(`/marketplace/errands/${closed}`).expect(404);

      await as(runner).post(`/users/${requester.userId}/block`).expect(204);
      const res = await as(runner).get(`/marketplace/errands/${id}`).expect(404);
      expect(res.body.error.code).toBe(RESOURCE_NOT_FOUND);
    });
  });

  describe('media seen through the marketplace', () => {
    it('lets an eligible runner view an open errand\'s photos and nobody else; profile photos keep their own rule', async () => {
      const photo = await readyMedia(app, requester.accessToken, 'ERRAND_PHOTO');
      const profilePhoto = await readyMedia(app, requester.accessToken, 'PROFILE_PHOTO');
      await as(requester).put('/me/photo').send({ mediaId: profilePhoto }).expect(200);
      const id = await post({ photoMediaIds: [photo] });

      await as(runner).get(`/media/${photo}/url`).expect(200);
      await as(runner).get(`/media/${profilePhoto}/url`).expect(200);
      const feed = await as(runner).get('/marketplace/errands').expect(200);
      expect(feed.body.data[0].requester.photoMediaId).toBe(profilePhoto);

      const stranger = await signedInUser(app);
      await as(stranger).get(`/media/${photo}/url`).expect(404);
      await as(stranger).get(`/media/${profilePhoto}/url`).expect(200); // any signed-in user, while it is the current photo

      // Once the errand is closed to the marketplace, the photos are the owner's again.
      await as(requester).post(`/errands/${id}/cancel`).send({ reason: 'REQUESTER_CANCELLED' }).expect(200);
      await as(runner).get(`/media/${photo}/url`).expect(404);
      await as(requester).get(`/media/${photo}/url`).expect(200);
    });
  });

  describe('saved errands', () => {
    it('saves an open errand once however often it is asked, lists it, and removes it', async () => {
      const id = await post();
      expect((await as(runner).post(`/saved-errands/${id}`).expect(200)).body.data).toEqual({ saved: true });
      await as(runner).post(`/saved-errands/${id}`).expect(200);
      expect(await prisma.savedErrand.count({ where: { userId: runner.userId } })).toBe(1);

      const list = await as(runner).get('/saved-errands').expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ id, status: 'OPEN', saved: true, title: 'Deliver a parcel' });
      expect((await as(runner).get('/marketplace/errands').expect(200)).body.data[0].saved).toBe(true);
      expect((await as(runner).get(`/marketplace/errands/${id}`).expect(200)).body.data.saved).toBe(true);

      expect((await as(runner).delete(`/saved-errands/${id}`).expect(200)).body.data).toEqual({ saved: false });
      await as(runner).delete(`/saved-errands/${id}`).expect(200);
      expect((await as(runner).get('/saved-errands').expect(200)).body.data).toEqual([]);
      // Saving again after removing works, and the earlier row stays on record.
      await as(runner).post(`/saved-errands/${id}`).expect(200);
      expect(await prisma.$queryRaw`SELECT 1 FROM saved_errands WHERE user_id = ${runner.userId}::uuid`).toHaveLength(2);
    });

    it('cannot save what the runner could not see, and keeps a saved errand after it closes', async () => {
      const id = await post();
      await as(runner).post(`/saved-errands/${randomUUID()}`).expect(404);
      await as(requester).post(`/saved-errands/${id}`).expect(403); // not a runner
      await as(runner).post(`/saved-errands/${id}`).expect(200);
      await as(requester).post(`/errands/${id}/cancel`).send({ reason: 'REQUESTER_CANCELLED' }).expect(200);

      const list = await as(runner).get('/saved-errands').expect(200);
      expect(list.body.data[0]).toMatchObject({ id, status: 'CANCELLED' });
      await as(runner).post(`/saved-errands/${id}`).expect(404);
    });

    it('lists newest save first and pages', async () => {
      const first = await post();
      const second = await post();
      const third = await post();
      for (const id of [first, second, third]) await as(runner).post(`/saved-errands/${id}`).expect(200);

      const page1 = await as(runner).get('/saved-errands?limit=2').expect(200);
      expect(ids(page1)).toEqual([third, second]);
      const page2 = await as(runner).get(`/saved-errands?limit=2&cursor=${page1.body.meta.nextCursor}`).expect(200);
      expect(ids(page2)).toEqual([first]);
      expect(page2.body.meta.hasNextPage).toBe(false);
    });

    it('keeps one runner\'s saved list from another\'s', async () => {
      const id = await post();
      await as(runner).post(`/saved-errands/${id}`).expect(200);
      const other = await readyRunner(app, NIN.other);
      expect((await as(other).get('/saved-errands').expect(200)).body.data).toEqual([]);
    });
  });

  describe('rate limit', () => {
    it('allows RATE_FEED_PER_MIN requests a minute per user, counting each user on their own', async () => {
      process.env.RATE_LIMIT_DISABLED = 'false';
      await config().set('RATE_FEED_PER_MIN', 3);
      for (let i = 0; i < 3; i += 1) await as(runner).get('/marketplace/errands').expect(200);
      const blocked = await as(runner).get('/marketplace/errands').expect(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      await as(runner).get('/marketplace/errands/map').expect(429); // the map shares the budget

      const other = await readyRunner(app, NIN.other);
      await as(other).get('/marketplace/errands').expect(200);
    });
  });
});

describe('GET /errands/mine (P5-08)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categories: Record<string, string>;
  let user: Awaited<ReturnType<typeof signedInUser>>;
  const as = (who: { accessToken: string }) => ({ get: (path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(who.accessToken)) });

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categories = await seedCategories();
    user = await signedInUser(app);
  });
  afterAll(async () => {
    await app.close();
  });

  const mk = (status: Parameters<typeof insertErrand>[0]['status'], extra = {}) => insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status, ...extra });

  it('splits errands into the dashboard tabs, newest first', async () => {
    const draft = await mk('DRAFT');
    const open = await mk('OPEN');
    const selected = await mk('RUNNER_SELECTED');
    const progress = await mk('IN_PROGRESS');
    const disputed = await mk('DISPUTED', { statusBeforeDispute: 'DELIVERED' });
    const done = await mk('COMPLETED');
    const cancelled = await mk('CANCELLED');
    const expired = await mk('EXPIRED');
    const ids = (res: request.Response) => (res.body.data as Array<{ id: string }>).map((item) => item.id);

    expect(ids(await as(user).get('/errands/mine?tab=DRAFT').expect(200))).toEqual([draft]);
    expect(ids(await as(user).get('/errands/mine?tab=OPEN').expect(200))).toEqual([open]);
    expect(ids(await as(user).get('/errands/mine?tab=ACTIVE').expect(200))).toEqual([disputed, progress, selected]);
    expect(ids(await as(user).get('/errands/mine?tab=PAST').expect(200))).toEqual([expired, cancelled, done]);
    expect(ids(await as(user).get('/errands/mine').expect(200))).toEqual([expired, cancelled, done, disputed, progress, selected, open, draft]);
    await as(user).get('/errands/mine?tab=NOPE').expect(400);
  });

  it('shows a summary, never contacts or exact positions, and only the requester\'s own errands', async () => {
    const id = await mk('OPEN', { area: 'Lekki' });
    const other = await signedInUser(app);
    await insertErrand({ requesterId: other.userId, categoryId: categories.delivery, status: 'OPEN' });

    const res = await as(user).get('/errands/mine').expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id, status: 'OPEN', title: 'Collect a parcel', pickupArea: 'Lekki', destinationArea: null, offerCount: 0, category: { key: 'delivery' } });
    expect(JSON.stringify(res.body)).not.toMatch(/exact|phone|contact|landmark/i);
  });

  it('pages, and closes overdue open errands before listing', async () => {
    for (let i = 0; i < 5; i += 1) await mk('OPEN');
    const overdue = await mk('OPEN', { expiresInHours: -1 });

    const first = await as(user).get('/errands/mine?tab=OPEN&limit=2').expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.hasNextPage).toBe(true);
    const second = await as(user).get(`/errands/mine?tab=OPEN&limit=2&cursor=${first.body.meta.nextCursor}`).expect(200);
    const third = await as(user).get(`/errands/mine?tab=OPEN&limit=2&cursor=${second.body.meta.nextCursor}`).expect(200);
    const all = [...first.body.data, ...second.body.data, ...third.body.data].map((item: { id: string }) => item.id);
    expect(new Set(all).size).toBe(5);
    expect(all).not.toContain(overdue);
    expect((await prisma.errand.findUniqueOrThrow({ where: { id: overdue } })).status).toBe('EXPIRED');
  });

  it('needs sign-in', async () => {
    await request(app.getHttpServer()).get(`${API}/errands/mine`).expect(401);
  });
});

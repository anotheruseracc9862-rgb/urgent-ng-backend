import { describe, it, expect, beforeAll, beforeEach, afterAll, vi, afterEach } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, enforcementActionFor, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, loginMobile, registerUser, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { readyMedia } from '../test/media.helper.js';
import { fakeStorage } from '../test/media.helper.js';
import { LAGOS_DESTINATION, LAGOS_PICKUP, createDraft, draftBody, insertErrand, openErrand, publishErrand, seedCategories, seedProhibitedItems } from '../test/errand.helper.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { MAPS_PROVIDER } from '../common/providers/maps.provider.js';
import type { FakeMapsProvider } from '../common/providers/fakes/maps.fake.js';
import { OFFER_RECONFIRMATION_HOOK } from './offer-reconfirmation.hook.js';
import { haversineMeters } from './location-privacy.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Errands: drafts, publishing, editing, cancelling (P5-04, P5-05)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categories: Record<string, string>;
  let user: Awaited<ReturnType<typeof signedInUser>>;
  const server = () => app.getHttpServer();
  const as = (who: { accessToken: string }) => ({
    get: (path: string) => request(server()).get(`${API}${path}`).set(...bearer(who.accessToken)),
    post: (path: string) => request(server()).post(`${API}${path}`).set(...bearer(who.accessToken)),
    patch: (path: string) => request(server()).patch(`${API}${path}`).set(...bearer(who.accessToken)),
  });
  const config = () => app.get(BusinessConfigService);
  const maps = () => app.get<FakeMapsProvider>(MAPS_PROVIDER);
  const db = async <T = Record<string, unknown>>(sql: string, id: string): Promise<T[]> => prisma.$queryRawUnsafe<T[]>(sql, id);

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categories = await seedCategories();
    await seedProhibitedItems();
    fakeStorage(app).reset();
    maps().clearCalls();
    user = await signedInUser(app);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await app.close();
  });

  describe('POST /errands (create a draft)', () => {
    it('creates an incomplete draft from a title and a category', async () => {
      const res = await createDraft(app, user, { categoryId: categories.delivery, title: 'Parcel' }).expect(201);

      expect(res.body.data).toMatchObject({
        status: 'DRAFT',
        version: 0,
        title: 'Parcel',
        description: '',
        pickup: null,
        destination: null,
        timeMode: null,
        priority: 'STANDARD',
        offerCount: 0,
        publishedAt: null,
        expiresAt: null,
        photos: [],
      });
      expect(res.body.data.category).toMatchObject({ key: 'delivery' });
    });

    it('needs sign-in, a real category and a title', async () => {
      await request(server()).post(`${API}/errands`).send({ categoryId: categories.delivery, title: 'x' }).expect(401);
      await createDraft(app, user, { categoryId: randomUUID(), title: 'x' }).expect(400);
      await createDraft(app, user, { categoryId: categories.delivery }).expect(400);
      await createDraft(app, user, { categoryId: categories.delivery, title: '' }).expect(400);
      await createDraft(app, user, { categoryId: categories.delivery, title: 'x', pickup: { point: { lat: 120, lng: 3 } } }).expect(400);
    });

    it('keeps exact and approximate points apart and fills the area from the maps provider', async () => {
      const res = await createDraft(app, user, draftBody(categories.delivery)).expect(201);
      const id = res.body.data.id as string;

      expect(res.body.data.pickup).toMatchObject({ area: 'Yaba', lga: 'Lagos Mainland', state: 'Lagos', landmark: 'Opposite the Shell station' });
      expect(res.body.data.pickup.exact).toEqual(LAGOS_PICKUP);
      expect(res.body.data.destination.addressText).toBe('14 Allen Avenue, Ikeja');

      const rows = await db<{ type: string; exact_lat: number; exact_lng: number; approx_lat: number; approx_lng: number }>(
        `SELECT type::text AS type, ST_Y(exact_point::geometry) AS exact_lat, ST_X(exact_point::geometry) AS exact_lng,
                ST_Y(approx_point::geometry) AS approx_lat, ST_X(approx_point::geometry) AS approx_lng
         FROM errand_locations WHERE errand_id = $1::uuid ORDER BY type`,
        id,
      );
      expect(rows.map((row) => row.type)).toEqual(['ERRAND_DESTINATION', 'ERRAND_PICKUP']);
      for (const row of rows) {
        const meters = haversineMeters({ lat: row.exact_lat, lng: row.exact_lng }, { lat: row.approx_lat, lng: row.approx_lng });
        expect(meters).toBeGreaterThan(0);
        expect(meters).toBeLessThan(600);
      }
      // The area was looked up for the approximate point, never for the exact one.
      const [lookup] = maps().getCalls('reverseGeocode');
      expect(lookup.args).not.toEqual([LAGOS_PICKUP.lat, LAGOS_PICKUP.lng]);
    });

    it('points the feed index at the pickup, or at the destination when there is no pickup', async () => {
      const withBoth = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id as string;
      const shopping = (await createDraft(app, user, draftBody(categories.shopping_purchase, { pickup: undefined })).expect(201)).body.data.id as string;

      const near = await prisma.$queryRaw<Array<{ id: string; to_pickup: number; to_destination: number }>>`
        SELECT e.id::text,
               ST_Distance(e.feed_point, (SELECT approx_point FROM errand_locations WHERE errand_id = e.id AND type = 'ERRAND_PICKUP')) AS to_pickup,
               ST_Distance(e.feed_point, (SELECT approx_point FROM errand_locations WHERE errand_id = e.id AND type = 'ERRAND_DESTINATION')) AS to_destination
        FROM errands e WHERE e.id IN (${withBoth}::uuid, ${shopping}::uuid)`;
      expect(near.find((row) => row.id === withBoth)?.to_pickup).toBe(0);
      expect(near.find((row) => row.id === shopping)?.to_destination).toBe(0);
    });

    it('still saves when the maps provider fails, with a generic area', async () => {
      maps().scriptOutcomes('reverseGeocode', [{ success: false, error: 'quota exceeded' }]);

      const res = await createDraft(app, user, draftBody(categories.delivery, { destination: undefined })).expect(201);

      expect(res.body.data.pickup).toMatchObject({ area: 'Nigeria', lga: null, state: null });
    });

    it('stores contacts encrypted and returns them only to the requester', async () => {
      const res = await createDraft(
        app,
        user,
        draftBody(categories.delivery, {
          pickupContact: { name: 'Chika Eze', phone: '08031234567' },
          dropoffContact: { name: 'Ngozi Eze', phone: '+2348021234567' },
        }),
      ).expect(201);

      expect(res.body.data.pickupContact).toEqual({ name: 'Chika Eze', phone: '+2348031234567' });
      expect(res.body.data.dropoffContact).toEqual({ name: 'Ngozi Eze', phone: '+2348021234567' });
      const [row] = await db<Record<string, string>>(`SELECT pickup_name, pickup_phone, dropoff_name, dropoff_phone, encryption_key_id FROM errand_contacts WHERE errand_id = $1::uuid`, res.body.data.id);
      for (const value of [row.pickup_name, row.pickup_phone, row.dropoff_name, row.dropoff_phone]) {
        expect(value).toMatch(/^v1\.primary\./);
      }
      expect(JSON.stringify(row)).not.toMatch(/Chika|Ngozi|803123|802123/);
      expect(row.encryption_key_id).toBe('primary');
    });

    it('refuses plain text in a contact column at the database', async () => {
      const id = await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status: 'DRAFT' });
      await expect(
        prisma.$executeRaw`INSERT INTO errand_contacts (errand_id, pickup_phone, encryption_key_id, updated_at) VALUES (${id}::uuid, '+2348031234567', 'primary', now())`,
      ).rejects.toThrow(/errand_contacts_encrypted_only/);
    });

    it('does not decrypt a contact copied to another errand (the errand id is bound in)', async () => {
      const a = (await createDraft(app, user, draftBody(categories.delivery, { pickupContact: { phone: '08031234567' } })).expect(201)).body.data.id as string;
      const b = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id as string;
      await prisma.$executeRaw`
        INSERT INTO errand_contacts (errand_id, pickup_phone, encryption_key_id, updated_at)
        SELECT ${b}::uuid, pickup_phone, encryption_key_id, now() FROM errand_contacts WHERE errand_id = ${a}::uuid`;

      const res = await as(user).get(`/errands/${b}`).expect(200);

      expect(res.body.data.pickupContact).toBeNull();
    });

    it('rejects a phone number that is not Nigerian', async () => {
      await createDraft(app, user, draftBody(categories.delivery, { pickupContact: { phone: '12345' } })).expect(400);
    });

    it('attaches READY errand photos in order, up to the limit, and only the requester\'s own', async () => {
      const first = await readyMedia(app, user.accessToken, 'ERRAND_PHOTO');
      const second = await readyMedia(app, user.accessToken, 'ERRAND_PHOTO');
      const res = await createDraft(app, user, draftBody(categories.delivery, { photoMediaIds: [second, first] })).expect(201);
      expect(res.body.data.photos).toEqual([
        { mediaId: second, position: 0 },
        { mediaId: first, position: 1 },
      ]);

      const other = await signedInUser(app);
      const theirs = await readyMedia(app, other.accessToken, 'ERRAND_PHOTO');
      await createDraft(app, user, draftBody(categories.delivery, { photoMediaIds: [theirs] })).expect(400);
      const wrongPurpose = await readyMedia(app, user.accessToken, 'PROFILE_PHOTO');
      await createDraft(app, user, draftBody(categories.delivery, { photoMediaIds: [wrongPurpose] })).expect(400);

      await config().set('MAX_ERRAND_PHOTOS', 1);
      await createDraft(app, user, draftBody(categories.delivery, { photoMediaIds: [first, second] })).expect(400);
    });

    it('limits how many drafts a requester keeps (config MAX_DRAFTS_PER_REQUESTER)', async () => {
      await config().set('MAX_DRAFTS_PER_REQUESTER', 2);
      await createDraft(app, user, draftBody(categories.delivery)).expect(201);
      await createDraft(app, user, draftBody(categories.delivery)).expect(201);

      const res = await createDraft(app, user, draftBody(categories.delivery)).expect(422);

      expect(res.body.error).toMatchObject({ code: 'ERRAND_NOT_ELIGIBLE', details: { reason: 'DRAFT_LIMIT', limit: 2 } });
    });

    it('holds the draft limit even when many drafts are created at once', async () => {
      await config().set('MAX_DRAFTS_PER_REQUESTER', 3);
      const results = await Promise.all(Array.from({ length: 8 }, () => createDraft(app, user, draftBody(categories.delivery))));
      expect(results.filter((res) => res.status === 201)).toHaveLength(3);
      expect(await prisma.errand.count({ where: { requesterId: user.userId } })).toBe(3);
    });

    it('rejects a clearly prohibited item in a draft', async () => {
      const res = await createDraft(app, user, draftBody(categories.delivery, { description: 'Carry some Cocaine across town' })).expect(422);
      expect(res.body.error.details).toMatchObject({ reason: 'PROHIBITED_ITEM', keywords: ['cocaine'] });
    });
  });

  describe('GET /errands/:id', () => {
    it('is private to the requester', async () => {
      const id = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
      const other = await signedInUser(app);

      await as(user).get(`/errands/${id}`).expect(200);
      await as(other).get(`/errands/${id}`).expect(404);
      await as(user).get(`/errands/${randomUUID()}`).expect(404);
      await as(user).get('/errands/not-a-uuid').expect(400);
    });
  });

  describe('PATCH /errands/:id on a draft', () => {
    it('changes fields, replaces and removes locations, and bumps the version', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data;

      const res = await as(user)
        .patch(`/errands/${draft.id}`)
        .send({ title: 'New title', destination: null, pickup: { point: { lat: 6.45, lng: 3.4 }, landmark: 'By the jetty' }, suggestedBudgetMinor: 250000, itemSize: 'SMALL' })
        .expect(200);

      expect(res.body.data).toMatchObject({ title: 'New title', destination: null, suggestedBudgetMinor: 250000, itemSize: 'SMALL', version: 1 });
      expect(res.body.data.pickup).toMatchObject({ landmark: 'By the jetty', exact: { lat: 6.45, lng: 3.4 } });
      const live = await db<{ n: number }>(`SELECT count(*)::int AS n FROM errand_locations WHERE errand_id = $1::uuid AND deleted_at IS NULL`, draft.id);
      expect(live[0].n).toBe(1);
      const removed = await db<{ n: number }>(`SELECT count(*)::int AS n FROM errand_locations WHERE errand_id = $1::uuid AND deleted_at IS NOT NULL`, draft.id);
      expect(removed[0].n).toBe(1); // soft deleted, never destroyed
    });

    it('does nothing, and does not bump the version, when nothing changes', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data;
      const res = await as(user).patch(`/errands/${draft.id}`).send({ title: draft.title, pickup: { point: LAGOS_PICKUP, landmark: 'Opposite the Shell station' } }).expect(200);
      expect(res.body.data.version).toBe(0);
    });

    it('keeps the ASAP and SCHEDULED rules, and the priority that follows them', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery, { timeMode: undefined })).expect(201)).body.data;
      await as(user).patch(`/errands/${draft.id}`).send({ timeMode: 'SCHEDULED' }).expect(400);
      await as(user).patch(`/errands/${draft.id}`).send({ timeMode: 'ASAP', scheduledAt: new Date(Date.now() + 5 * 3_600_000).toISOString() }).expect(400);

      const asap = await as(user).patch(`/errands/${draft.id}`).send({ timeMode: 'ASAP' }).expect(200);
      expect(asap.body.data).toMatchObject({ timeMode: 'ASAP', priority: 'URGENT' });
      const scheduled = await as(user).patch(`/errands/${draft.id}`).send({ timeMode: 'SCHEDULED', scheduledAt: new Date(Date.now() + 5 * 3_600_000).toISOString() }).expect(200);
      expect(scheduled.body.data).toMatchObject({ timeMode: 'SCHEDULED', priority: 'STANDARD' });
    });

    it('is refused for someone else\'s errand, and for a stale version', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data;
      const other = await signedInUser(app);
      await as(other).patch(`/errands/${draft.id}`).send({ title: 'Mine now' }).expect(404);

      await as(user).patch(`/errands/${draft.id}`).send({ title: 'One' }).expect(200);
      const stale = await as(user).patch(`/errands/${draft.id}`).send({ title: 'Two', expectedVersion: 0 }).expect(409);
      expect(stale.body.error).toMatchObject({ code: 'ERRAND_INVALID_STATE', details: { reason: 'VERSION_MISMATCH' } });
    });

    it('refuses to edit an errand once a runner is selected', async () => {
      const id = await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status: 'RUNNER_SELECTED' });
      const res = await as(user).patch(`/errands/${id}`).send({ title: 'Changed my mind' }).expect(409);
      expect(res.body.error.code).toBe('ERRAND_INVALID_STATE');
    });

    it('refuses a clearly prohibited item once it is typed', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data;
      const res = await as(user).patch(`/errands/${draft.id}`).send({ description: 'Please collect a PISTOL for me' }).expect(422);
      expect(res.body.error.details).toMatchObject({ reason: 'PROHIBITED_ITEM', keywords: ['pistol'] });
      const [row] = await db<{ description: string }>(`SELECT description FROM errands WHERE id = $1::uuid`, draft.id);
      expect(row.description).not.toMatch(/pistol/i); // rolled back
    });
  });

  describe('POST /errands/:id/publish', () => {
    it('opens a complete draft: ASAP is URGENT and expires after ERRAND_EXPIRY_HOURS', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data;
      const before = Date.now();

      const res = await publishErrand(app, user, draft.id).expect(201);

      expect(res.body.data).toMatchObject({ status: 'OPEN', priority: 'URGENT', timeMode: 'ASAP' });
      const publishedAt = new Date(res.body.data.publishedAt).getTime();
      expect(publishedAt).toBeGreaterThanOrEqual(before - 2000);
      expect(new Date(res.body.data.expiresAt).getTime() - publishedAt).toBe(24 * 3_600_000);
      const [row] = await db<{ confirmed: Date; policy: string }>(`SELECT prohibited_items_confirmed_at AS confirmed, prohibited_policy_version AS policy FROM errands WHERE id = $1::uuid`, draft.id);
      expect(row.confirmed).toBeInstanceOf(Date);
      expect(row.policy).toBe('1.0');
    });

    it('uses ERRAND_EXPIRY_HOURS from configuration', async () => {
      await config().set('ERRAND_EXPIRY_HOURS', 6);
      const id = await openErrand(app, user, categories.delivery);
      const res = await as(user).get(`/errands/${id}`).expect(200);
      expect(new Date(res.body.data.expiresAt).getTime() - new Date(res.body.data.publishedAt).getTime()).toBe(6 * 3_600_000);
    });

    it('gives a scheduled errand a deadline 30 minutes before its start', async () => {
      const start = new Date(Date.now() + 3 * 3_600_000);
      const id = await openErrand(app, user, categories.delivery, { timeMode: 'SCHEDULED', scheduledAt: start.toISOString() });
      const res = await as(user).get(`/errands/${id}`).expect(200);
      expect(res.body.data).toMatchObject({ priority: 'STANDARD', timeMode: 'SCHEDULED' });
      expect(new Date(res.body.data.expiresAt).getTime()).toBe(start.getTime() - 30 * 60_000);
    });

    it('caps a scheduled errand\'s open time at SCHEDULED_ERRAND_MAX_OPEN_DAYS', async () => {
      await config().set('SCHEDULE_MAX_DAYS_AHEAD', 10);
      const start = new Date(Date.now() + 9 * 86_400_000);
      const id = await openErrand(app, user, categories.delivery, { timeMode: 'SCHEDULED', scheduledAt: start.toISOString() });
      const res = await as(user).get(`/errands/${id}`).expect(200);
      expect(new Date(res.body.data.expiresAt).getTime() - new Date(res.body.data.publishedAt).getTime()).toBe(7 * 86_400_000);
    });

    it.each([
      ['30 minutes ahead', 30 * 60_000],
      ['8 days ahead', 8 * 86_400_000],
    ])('refuses a scheduled time %s with SCHEDULE_OUT_OF_RANGE', async (_label, offset) => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery, { timeMode: 'SCHEDULED', scheduledAt: new Date(Date.now() + offset).toISOString() })).expect(201)).body.data;
      const res = await publishErrand(app, user, draft.id).expect(400);
      expect(res.body.error.code).toBe('SCHEDULE_OUT_OF_RANGE');
      expect((await as(user).get(`/errands/${draft.id}`)).body.data.status).toBe('DRAFT');
    });

    it('applies the category location rules', async () => {
      const noDestination = (await createDraft(app, user, draftBody(categories.delivery, { destination: undefined })).expect(201)).body.data.id;
      const res = await publishErrand(app, user, noDestination).expect(422);
      expect(res.body.error).toMatchObject({ code: 'ERRAND_NOT_ELIGIBLE', details: { reason: 'INCOMPLETE', problems: [{ field: 'destination', code: 'REQUIRED' }] } });

      const noPickup = (await createDraft(app, user, draftBody(categories.delivery, { pickup: undefined })).expect(201)).body.data.id;
      expect((await publishErrand(app, user, noPickup).expect(422)).body.error.details.problems).toEqual([{ field: 'pickup', code: 'REQUIRED' }]);

      // Pickup: destination optional. Shopping: pickup optional. Document and Other: pickup required.
      const pickupOnly = (await createDraft(app, user, draftBody(categories.pickup, { destination: undefined })).expect(201)).body.data.id;
      await publishErrand(app, user, pickupOnly).expect(201);
      const shopping = (await createDraft(app, user, draftBody(categories.shopping_purchase, { pickup: undefined })).expect(201)).body.data.id;
      await publishErrand(app, user, shopping).expect(201);
      const other = (await createDraft(app, user, draftBody(categories.other, { pickup: undefined, destination: undefined })).expect(201)).body.data.id;
      await publishErrand(app, user, other).expect(422);
    });

    it('lists every missing field, and publishes a pin plus landmark without an address', async () => {
      const bare = (await createDraft(app, user, { categoryId: categories.delivery, title: 'Parcel' }).expect(201)).body.data.id;
      const res = await publishErrand(app, user, bare).expect(422);
      expect(res.body.error.details.problems.map((p: { field: string }) => p.field).sort()).toEqual(['description', 'destination', 'pickup', 'timeMode'].sort());

      const pinOnly = (await createDraft(app, user, draftBody(categories.delivery, { pickup: { point: LAGOS_PICKUP, landmark: 'Near the market gate' }, destination: { point: LAGOS_DESTINATION } })).expect(201)).body.data.id;
      await publishErrand(app, user, pinOnly).expect(201);
    });

    it('blocks a prohibited item named in the title, description or instructions', async () => {
      for (const field of ['title', 'description', 'instructions']) {
        // Drafts refuse the words when typed, so put them in the way a rule added later would find them.
        const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
        await prisma.$executeRawUnsafe(`UPDATE errands SET ${field} = 'Hand over the AK47 quietly' WHERE id = $1::uuid`, draft);
        const res = await publishErrand(app, user, draft).expect(422);
        expect(res.body.error.details).toMatchObject({ reason: 'PROHIBITED_ITEM', keywords: ['ak47'], policyVersion: '1.0' });
      }
      // A plural is caught; a longer word that merely contains a keyword is not.
      await createDraft(app, user, draftBody(categories.delivery, { description: 'Two pistols for the display' })).expect(422);
      const harmless = (await createDraft(app, user, draftBody(categories.delivery, { description: 'Collect a pistolero costume for the party' })).expect(201)).body.data.id;
      await publishErrand(app, user, harmless).expect(201);
    });

    it('needs the prohibited-items confirmation', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
      await publishErrand(app, user, draft, { confirmed: false }).expect(400);
      await request(server()).post(`${API}/errands/${draft}/publish`).set(...bearer(user.accessToken)).set('Idempotency-Key', randomUUID()).send({}).expect(400);
    });

    it('needs an OTP-verified account', async () => {
      const unverified = await registerUser(app);
      const tokens = await loginMobile(app, unverified);
      const draft = (await createDraft(app, tokens, draftBody(categories.delivery)).expect(201)).body.data.id;

      const res = await publishErrand(app, tokens, draft).expect(403);

      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'ACCOUNT_NOT_VERIFIED' } });
    });

    it('needs an Idempotency-Key', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
      await request(server()).post(`${API}/errands/${draft}/publish`).set(...bearer(user.accessToken)).send({ prohibitedItemsConfirmed: true }).expect(400);
    });

    it('creates one open errand when the same request is sent twice', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
      const key = randomUUID();

      const first = await publishErrand(app, user, draft, { key }).expect(201);
      const second = await publishErrand(app, user, draft, { key }).expect(201);

      expect(second.body.data).toEqual(first.body.data);
      expect(await prisma.errand.count({ where: { status: 'OPEN' } })).toBe(1);
      const [events] = await db<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1::uuid AND event_type = 'errand.published'`, draft);
      expect(events.n).toBe(1);
    });

    it('refuses a second publish with a different key', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
      await publishErrand(app, user, draft).expect(201);
      const again = await publishErrand(app, user, draft).expect(409);
      expect(again.body.error.code).toBe('ERRAND_INVALID_STATE');
    });

    it('records history, audit and the published event in the same commit', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
      await publishErrand(app, user, draft).expect(201);

      const history = await db<{ f: string; t: string }>(`SELECT from_status::text AS f, to_status::text AS t FROM errand_status_history WHERE errand_id = $1::uuid`, draft);
      expect(history).toEqual([{ f: 'DRAFT', t: 'OPEN' }]);
      const events = await db<{ payload: Record<string, unknown> }>(`SELECT payload FROM outbox_events WHERE aggregate_id = $1::uuid AND event_type = 'errand.published'`, draft);
      expect(events[0].payload).toMatchObject({ errandId: draft, requesterId: user.userId, from: 'DRAFT', to: 'OPEN', categoryId: categories.delivery });
    });

    it('limits open errands (config MAX_OPEN_ERRANDS_PER_REQUESTER), even under parallel publishing', async () => {
      await config().set('MAX_OPEN_ERRANDS_PER_REQUESTER', 2);
      const drafts: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        drafts.push((await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id);
      }

      const results = await Promise.all(drafts.map((id) => publishErrand(app, user, id)));

      expect(results.filter((res) => res.status === 201)).toHaveLength(2);
      const refused = results.find((res) => res.status === 422)!;
      expect(refused.body.error).toMatchObject({ code: 'ERRAND_NOT_ELIGIBLE', details: { reason: 'OPEN_ERRAND_LIMIT', limit: 2 } });
      expect(await prisma.errand.count({ where: { requesterId: user.userId, status: 'OPEN' } })).toBe(2);
    });

    it('does not count drafts, finished or expired errands against the open limit', async () => {
      await config().set('MAX_OPEN_ERRANDS_PER_REQUESTER', 1);
      await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status: 'COMPLETED' });
      await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status: 'EXPIRED' });
      await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status: 'CANCELLED' });
      await createDraft(app, user, draftBody(categories.delivery)).expect(201);
      await openErrand(app, user, categories.delivery);
    });

    it('is closed by the posting kill switch', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
      await config().set('FEATURE_ERRAND_POSTING_ENABLED', false);
      await publishErrand(app, user, draft).expect(503);
      await createDraft(app, user, draftBody(categories.delivery)).expect(503);
    });

    it('is closed to a requester restricted from posting', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
      const action = await enforcementActionFor(user.userId);
      await prisma.$executeRaw`
        INSERT INTO user_restrictions (user_id, type, status, starts_at, ends_at, enforcement_action_id, updated_at)
        VALUES (${user.userId}::uuid, 'POSTING'::"UserRestrictionType", 'ACTIVE'::"RestrictionStatus", now() - interval '1 hour', now() + interval '1 day', ${action}::uuid, now())`;
      await publishErrand(app, user, draft).expect(403);
    });

    it('rejects a photo that is no longer usable', async () => {
      const photo = await readyMedia(app, user.accessToken, 'ERRAND_PHOTO');
      const draft = (await createDraft(app, user, draftBody(categories.delivery, { photoMediaIds: [photo] })).expect(201)).body.data.id;
      await prisma.$executeRaw`UPDATE media SET moderation_status = 'REMOVED'::"ModerationStatus" WHERE id = ${photo}::uuid`;
      await publishErrand(app, user, draft).expect(400);
    });
  });

  describe('editing an open errand (Backend PRD 11.5)', () => {
    const events = (id: string) => db<{ payload: Record<string, unknown> }>(`SELECT payload FROM outbox_events WHERE aggregate_id = $1::uuid AND event_type = 'errand.updated' ORDER BY occurred_at`, id);

    it('treats a title change as non-material: no snapshot, no flagging, an informational event', async () => {
      const id = await openErrand(app, user, categories.delivery);
      const flag = vi.spyOn(app.get(OFFER_RECONFIRMATION_HOOK), 'flagOffers');

      const res = await as(user).patch(`/errands/${id}`).send({ title: 'Deliver a parcel (fragile)', suggestedBudgetMinor: 300000 }).expect(200);

      expect(res.body.data).toMatchObject({ title: 'Deliver a parcel (fragile)', suggestedBudgetMinor: 300000, status: 'OPEN' });
      expect(flag).not.toHaveBeenCalled();
      expect(await db(`SELECT 1 FROM errand_versions WHERE errand_id = $1::uuid`, id)).toHaveLength(0);
      expect((await db<{ material_version: number }>(`SELECT material_version FROM errands WHERE id = $1::uuid`, id))[0].material_version).toBe(0);
      expect((await events(id))[0].payload).toMatchObject({ material: false, changedFields: ['title', 'suggestedBudgetMinor'] });
    });

    it('treats a pickup change as material: snapshot of the old values, offers flagged, runners told', async () => {
      const id = await openErrand(app, user, categories.delivery, { itemSize: 'SMALL' });
      const flag = vi.spyOn(app.get(OFFER_RECONFIRMATION_HOOK), 'flagOffers').mockResolvedValue(3);

      const res = await as(user).patch(`/errands/${id}`).send({ pickup: { point: { lat: 6.45, lng: 3.4 }, landmark: 'New spot' }, itemSize: 'LARGE' }).expect(200);

      expect(res.body.data.pickup.exact).toEqual({ lat: 6.45, lng: 3.4 });
      expect(flag).toHaveBeenCalledTimes(1);
      const versions = await db<{ version: number; snapshot: Record<string, unknown>; changed_fields: string[]; changed_by: string }>(
        `SELECT version, snapshot, changed_fields, changed_by::text FROM errand_versions WHERE errand_id = $1::uuid`,
        id,
      );
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ version: 1, changed_by: user.userId });
      expect([...versions[0].changed_fields].sort()).toEqual(['itemSize', 'pickup']);
      expect(versions[0].snapshot).toMatchObject({ itemSize: 'SMALL', title: 'Deliver a parcel' });
      const oldPickup = (versions[0].snapshot.locations as Array<{ type: string; exact: { lat: number; lng: number }; landmark: string }>).find((l) => l.type === 'ERRAND_PICKUP')!;
      expect(oldPickup).toMatchObject({ exact: LAGOS_PICKUP, landmark: 'Opposite the Shell station' });
      expect(JSON.stringify(versions[0].snapshot)).not.toMatch(/phone|contact/i);
      expect((await db<{ material_version: number; version: number }>(`SELECT material_version, version FROM errands WHERE id = $1::uuid`, id))[0]).toEqual({ material_version: 1, version: 2 });
      expect((await events(id))[0].payload).toMatchObject({ material: true, offersFlagged: 3 });
    });

    it.each([
      ['category', { categoryId: 'other' }],
      ['item value', { itemValueMinor: 500000 }],
      ['destination', { destination: { point: { lat: 6.55, lng: 3.35 } } }],
      ['time mode', { timeMode: 'SCHEDULED', scheduledAt: new Date(Date.now() + 4 * 3_600_000).toISOString() }],
    ])('treats a %s change as material', async (_name, change) => {
      const id = await openErrand(app, user, categories.delivery);
      const body = 'categoryId' in change ? { categoryId: categories[change.categoryId as string], pickup: { point: LAGOS_PICKUP } } : change;
      await as(user).patch(`/errands/${id}`).send(body).expect(200);
      expect((await db<{ material_version: number }>(`SELECT material_version FROM errands WHERE id = $1::uuid`, id))[0].material_version).toBe(1);
    });

    it('moves a scheduled errand\'s deadline when its start time changes', async () => {
      const id = await openErrand(app, user, categories.delivery, { timeMode: 'SCHEDULED', scheduledAt: new Date(Date.now() + 3 * 3_600_000).toISOString() });
      const later = new Date(Date.now() + 5 * 3_600_000);
      const res = await as(user).patch(`/errands/${id}`).send({ scheduledAt: later.toISOString() }).expect(200);
      expect(new Date(res.body.data.expiresAt).getTime()).toBe(later.getTime() - 30 * 60_000);
    });

    it('cannot be edited into an incomplete errand, and nothing is kept when it fails', async () => {
      const id = await openErrand(app, user, categories.delivery);
      const before = (await as(user).get(`/errands/${id}`).expect(200)).body.data;
      const res = await as(user).patch(`/errands/${id}`).send({ destination: null, title: 'Changed' }).expect(422);
      expect(res.body.error.details.problems).toEqual([{ field: 'destination', code: 'REQUIRED' }]);
      const after = (await as(user).get(`/errands/${id}`).expect(200)).body.data;
      expect(after.title).toBe('Deliver a parcel');
      expect(after.destination).not.toBeNull();
      expect(after.version).toBe(before.version);
      expect(await db(`SELECT 1 FROM errand_versions WHERE errand_id = $1::uuid`, id)).toHaveLength(0);
    });

    it('keeps a scheduled errand editable when it is about to start (the schedule rule only runs on schedule edits)', async () => {
      const id = await openErrand(app, user, categories.delivery, { timeMode: 'SCHEDULED', scheduledAt: new Date(Date.now() + 3 * 3_600_000).toISOString() });
      await prisma.$executeRaw`UPDATE errands SET scheduled_at = now() + interval '20 minutes', expires_at = now() + interval '10 minutes' WHERE id = ${id}::uuid`;
      await as(user).patch(`/errands/${id}`).send({ title: 'Still editable' }).expect(200);
    });

    it('refuses a prohibited item added to an open errand', async () => {
      const id = await openErrand(app, user, categories.delivery);
      await as(user).patch(`/errands/${id}`).send({ instructions: 'Deliver the cocaine to the back door' }).expect(422);
    });

    it('refuses edits after selection, completion or cancellation', async () => {
      for (const status of ['RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED'] as const) {
        const id = await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status });
        const res = await as(user).patch(`/errands/${id}`).send({ title: 'No' }).expect(409);
        expect(res.body.error.code).toBe('ERRAND_INVALID_STATE');
      }
    });
  });

  describe('POST /errands/:id/extend', () => {
    it('extends an open errand once, counting a fresh deadline from now, and keeps it open', async () => {
      const id = await openErrand(app, user, categories.delivery);
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() + interval '1 hour' WHERE id = ${id}::uuid`;

      const res = await as(user).post(`/errands/${id}/extend`).expect(200);

      expect(res.body.data).toMatchObject({ status: 'OPEN', extended: true });
      const hours = (new Date(res.body.data.expiresAt).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThan(24.1);
      const events = await db<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1::uuid AND event_type = 'errand.extended'`, id);
      expect(events[0].n).toBe(1);
    });

    it('allows only one extension', async () => {
      const id = await openErrand(app, user, categories.delivery);
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() + interval '1 hour' WHERE id = ${id}::uuid`;
      await as(user).post(`/errands/${id}/extend`).expect(200);
      const again = await as(user).post(`/errands/${id}/extend`).expect(422);
      expect(again.body.error).toMatchObject({ code: 'ERRAND_NOT_ELIGIBLE', details: { reason: 'ALREADY_EXTENDED' } });
    });

    it('refuses a deadline that has passed, an errand that is not open, and someone else\'s errand', async () => {
      const id = await openErrand(app, user, categories.delivery);
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() - interval '1 minute' WHERE id = ${id}::uuid`;
      expect((await as(user).post(`/errands/${id}/extend`).expect(409)).body.error.code).toBe('ERRAND_EXPIRED');
      expect((await prisma.errand.findUniqueOrThrow({ where: { id } })).status).toBe('EXPIRED'); // closed on the spot, not at the next sweep

      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
      expect((await as(user).post(`/errands/${draft}/extend`).expect(409)).body.error.code).toBe('ERRAND_INVALID_STATE');

      const fresh = await openErrand(app, user, categories.delivery);
      const other = await signedInUser(app);
      await as(other).post(`/errands/${fresh}/extend`).expect(404);
    });

    it('will not extend a scheduled errand past what its start time allows', async () => {
      const id = await openErrand(app, user, categories.delivery, { timeMode: 'SCHEDULED', scheduledAt: new Date(Date.now() + 3 * 3_600_000).toISOString() });
      const res = await as(user).post(`/errands/${id}/extend`).expect(422);
      expect(res.body.error.details.reason).toBe('NOTHING_TO_EXTEND');
    });
  });

  describe('POST /errands/:id/duplicate', () => {
    it('copies an errand into a new draft with its own id, approximate points, contacts and photos', async () => {
      const photo = await readyMedia(app, user.accessToken, 'ERRAND_PHOTO');
      const original = (
        await createDraft(
          app,
          user,
          draftBody(categories.delivery, {
            pickupContact: { name: 'Chika', phone: '08031234567' },
            itemSize: 'MEDIUM',
            suggestedBudgetMinor: 400000,
            photoMediaIds: [photo],
            timeMode: 'SCHEDULED',
            scheduledAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
          }),
        ).expect(201)
      ).body.data;

      const res = await as(user).post(`/errands/${original.id}/duplicate`).expect(201);
      const copy = res.body.data;

      expect(copy.id).not.toBe(original.id);
      expect(copy).toMatchObject({
        status: 'DRAFT',
        title: original.title,
        description: original.description,
        itemSize: 'MEDIUM',
        suggestedBudgetMinor: 400000,
        timeMode: null, // the schedule is not copied
        scheduledAt: null,
        pickupContact: { name: 'Chika', phone: '+2348031234567' },
        photos: [{ mediaId: photo, position: 0 }],
      });
      expect(copy.pickup.exact).toEqual(LAGOS_PICKUP);
      // A new errand gets its own private offset.
      expect(copy.pickup.approx).not.toEqual(original.pickup.approx);
    });

    it('copies an ASAP errand as ASAP, works on a finished errand, and respects the draft limit', async () => {
      const done = await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status: 'COMPLETED' });
      const copy = await as(user).post(`/errands/${done}/duplicate`).expect(201);
      expect(copy.body.data).toMatchObject({ status: 'DRAFT', timeMode: 'ASAP', priority: 'URGENT' });

      await config().set('MAX_DRAFTS_PER_REQUESTER', 1);
      await as(user).post(`/errands/${done}/duplicate`).expect(422);
    });

    it('is private to the requester', async () => {
      const id = await openErrand(app, user, categories.delivery);
      const other = await signedInUser(app);
      await as(other).post(`/errands/${id}/duplicate`).expect(404);
    });
  });

  describe('POST /errands/:id/cancel', () => {
    const cancel = (who: { accessToken: string }, id: string, body: Record<string, unknown> = { reason: 'REQUESTER_CANCELLED' }) =>
      as(who).post(`/errands/${id}/cancel`).send(body);

    it('cancels a draft and an open errand, with the reason, time and actor on record', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
      expect((await cancel(user, draft).expect(200)).body.data.status).toBe('CANCELLED');

      const open = await openErrand(app, user, categories.delivery);
      const res = await cancel(user, open, { reason: 'DUPLICATE_ERRAND', note: 'posted twice' }).expect(200);

      expect(res.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'DUPLICATE_ERRAND' });
      expect(res.body.data.cancelledAt).toBeTruthy();
      const [row] = await db<{ note: string; by: string; by_type: string }>(`SELECT cancellation_note AS note, cancelled_by::text AS by, cancelled_by_type::text AS by_type FROM errands WHERE id = $1::uuid`, open);
      expect(row).toEqual({ note: 'posted twice', by: user.userId, by_type: 'USER' });
      const events = await db<{ payload: Record<string, unknown> }>(`SELECT payload FROM outbox_events WHERE aggregate_id = $1::uuid AND event_type = 'errand.cancelled'`, open);
      expect(events[0].payload).toMatchObject({ from: 'OPEN', to: 'CANCELLED', stage: 'OPEN' });
    });

    it('needs no reason for a draft or an open errand: nobody else is involved, so it is recorded as the requester changing their mind', async () => {
      const draft = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
      const cancelledDraft = await cancel(user, draft, {}).expect(200);
      expect(cancelledDraft.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'REQUESTER_CANCELLED' });

      const open = await openErrand(app, user, categories.delivery);
      const cancelledOpen = await cancel(user, open, { note: 'found someone myself' }).expect(200);
      expect(cancelledOpen.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'REQUESTER_CANCELLED' });
      const [row] = await db<{ note: string }>(`SELECT cancellation_note AS note FROM errands WHERE id = $1::uuid`, open);
      expect(row.note).toBe('found someone myself');
    });

    it.each(['RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS'] as const)('still asks why once a runner is involved (%s), and leaves the errand alone when it is missing', async (status) => {
      const id = await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status });
      const res = await cancel(user, id, {}).expect(400);
      expect(res.body.error.details).toMatchObject({ field: 'reason' });
      expect((await as(user).get(`/errands/${id}`)).body.data.status).toBe(status);
    });

    it('still refuses to cancel after pickup with a clear state error, whether or not a reason is sent', async () => {
      const id = await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status: 'PICKED_UP' });
      expect((await cancel(user, id, {}).expect(409)).body.error.code).toBe('ERRAND_INVALID_STATE');
    });

    it('frees the open slot and keeps the cancelled errand on record', async () => {
      await config().set('MAX_OPEN_ERRANDS_PER_REQUESTER', 1);
      const first = await openErrand(app, user, categories.delivery);
      const blocked = (await createDraft(app, user, draftBody(categories.delivery)).expect(201)).body.data.id;
      await publishErrand(app, user, blocked).expect(422);
      await cancel(user, first).expect(200);
      await publishErrand(app, user, blocked).expect(201);
      expect(await prisma.errand.count({ where: { id: first } })).toBe(1);
    });

    it.each(['RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS'] as const)('lets the requester cancel at %s', async (status) => {
      const id = await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status });
      const res = await cancel(user, id, { reason: 'SAFETY_CONCERN', note: 'felt unsafe' }).expect(200);
      expect(res.body.data.status).toBe('CANCELLED');
    });

    it.each(['PICKED_UP', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'EXPIRED'] as const)('refuses to cancel at %s', async (status) => {
      const id = await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status });
      const res = await cancel(user, id).expect(409);
      expect(res.body.error.code).toBe('ERRAND_INVALID_STATE');
    });

    it('leaves a disputed errand to the dispute process (only an admin or the system can cancel it)', async () => {
      const id = await insertErrand({ requesterId: user.userId, categoryId: categories.delivery, status: 'DISPUTED', statusBeforeDispute: 'DELIVERED' });
      const res = await cancel(user, id).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('accepts only reasons a requester can give, and only for their own errand', async () => {
      const id = await openErrand(app, user, categories.delivery);
      await cancel(user, id, { reason: 'RUNNER_CANCELLED' }).expect(400);
      await cancel(user, id, { reason: 'ADMIN_CANCELLED' }).expect(400);
      await cancel(user, id, { reason: 'NOT_A_REASON' }).expect(400);
      const other = await signedInUser(app);
      await cancel(other, id).expect(404);
      expect((await as(user).get(`/errands/${id}`)).body.data.status).toBe('OPEN');
    });

    it('answers a second cancel with ERRAND_INVALID_STATE', async () => {
      const id = await openErrand(app, user, categories.delivery);
      await cancel(user, id).expect(200);
      await cancel(user, id).expect(409);
    });
  });
});

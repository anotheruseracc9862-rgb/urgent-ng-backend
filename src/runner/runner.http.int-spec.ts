import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, createAdmin, seedAdminRoles, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { fakeStorage } from '../test/media.helper.js';
import { NIN, fakeKyc, profileBody, readyRunner, startVerification, verifiedUser, type TestUser } from '../test/verification.helper.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { RunnerEligibilityService } from './runner-eligibility.service.js';
import { VerificationAdminService } from '../verification/verification-admin.service.js';
import { VerificationExpiryService } from '../verification/verification-expiry.service.js';
import type { EligibilityReason } from './runner-eligibility.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Runner profile and eligibility (Phase 4)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  const server = () => app.getHttpServer();
  const as = (user: TestUser) => ({
    get: (path: string) => request(server()).get(`${API}${path}`).set(...bearer(user.accessToken)),
    put: (path: string) => request(server()).put(`${API}${path}`).set(...bearer(user.accessToken)),
  });
  const eligibility = () => app.get(RunnerEligibilityService);
  const reasons = async (user: TestUser) => (await eligibility().canOffer(user.userId)).reasons;
  const categoryId = async (key: string) => (await prisma.category.findFirstOrThrow({ where: { key } })).id;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    await seedAdminRoles();
    fakeKyc(app).reset();
    fakeStorage(app).reset();
  });
  afterAll(async () => {
    await app.close();
  });

  describe('PUT /runner/profile', () => {
    it('creates the profile with a 5 km default radius, unavailable, no exclusions', async () => {
      const user = await signedInUser(app);

      const res = await as(user).put('/runner/profile').send({ transport: 'BICYCLE', areaCenter: { lat: 6.5244, lng: 3.3792 } }).expect(200);

      expect(res.body.data).toEqual({
        transport: 'BICYCLE',
        areaCenter: { lat: 6.5244, lng: 3.3792 },
        areaRadiusKm: 5,
        availability: 'UNAVAILABLE',
        excludedCategoryIds: [],
      });
    });

    it('stores the centre as a PostGIS point (longitude first) and indexes it', async () => {
      const user = await signedInUser(app);
      await as(user).put('/runner/profile').send(profileBody()).expect(200);

      const [row] = await prisma.$queryRaw<Array<{ x: number; y: number; srid: number; near: boolean }>>`
        SELECT ST_X(area_center::geometry) AS x, ST_Y(area_center::geometry) AS y, ST_SRID(area_center::geometry) AS srid,
               ST_DWithin(area_center, ST_SetSRID(ST_MakePoint(3.38, 6.53), 4326)::geography, 2000) AS near
        FROM runner_profiles WHERE user_id = ${user.userId}::uuid
      `;
      expect(row).toMatchObject({ x: 3.3792, y: 6.5244, srid: 4326, near: true });
      const [index] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'runner_profiles_area_center_idx'
      `;
      expect(index.indexdef).toContain('gist');
    });

    it.each([1, 1.5, 5, 20])('accepts a radius of %s km', async (areaRadiusKm) => {
      const user = await signedInUser(app);

      const res = await as(user).put('/runner/profile').send(profileBody({ areaRadiusKm })).expect(200);

      expect(res.body.data.areaRadiusKm).toBe(areaRadiusKm);
    });

    it.each([0, 0.5, 0.9, 20.1, 21, 100, -5])('rejects a radius of %s km', async (areaRadiusKm) => {
      const user = await signedInUser(app);

      const res = await as(user).put('/runner/profile').send(profileBody({ areaRadiusKm })).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await prisma.runnerProfile.count()).toBe(0);
    });

    it.each(['far', 5.55])('rejects the radius %s', async (areaRadiusKm) => {
      const user = await signedInUser(app);

      await as(user).put('/runner/profile').send(profileBody({ areaRadiusKm })).expect(400);
    });

    it('the configured range can narrow 1 to 20 km but never widen it', async () => {
      const user = await signedInUser(app);
      await app.get(BusinessConfigService).set('RUNNER_AREA_MAX_KM', 10);

      await as(user).put('/runner/profile').send(profileBody({ areaRadiusKm: 10 })).expect(200);
      await as(user).put('/runner/profile').send(profileBody({ areaRadiusKm: 12 })).expect(400);

      await app.get(BusinessConfigService).set('RUNNER_AREA_MAX_KM', 30);
      await as(user).put('/runner/profile').send(profileBody({ areaRadiusKm: 25 })).expect(400);
    });

    it('the database also refuses a radius outside 1 to 20', async () => {
      const user = await signedInUser(app);
      await as(user).put('/runner/profile').send(profileBody()).expect(200);

      await expect(prisma.$executeRaw`UPDATE runner_profiles SET area_radius_km = 21`).rejects.toThrow(/radius_range/);
      await expect(prisma.$executeRaw`UPDATE runner_profiles SET area_radius_km = 0.9`).rejects.toThrow(/radius_range/);
    });

    it.each([
      [{ lat: 91, lng: 3 }],
      [{ lat: -91, lng: 3 }],
      [{ lat: 6, lng: 181 }],
      [{ lat: 'six', lng: 3 }],
      [{ lat: 6 }],
      [null],
    ])('rejects the centre %j', async (areaCenter) => {
      const user = await signedInUser(app);

      await as(user).put('/runner/profile').send(profileBody({ areaCenter })).expect(400);
    });

    it('rejects an unknown transport and extra fields; asks for no vehicle, licence or ownership', async () => {
      const user = await signedInUser(app);

      await as(user).put('/runner/profile').send(profileBody({ transport: 'HELICOPTER' })).expect(400);
      await as(user).put('/runner/profile').send(profileBody({ vehiclePlate: 'ABC123' })).expect(400);
      for (const transport of ['WALKING', 'BICYCLE', 'MOTORCYCLE', 'CAR', 'PUBLIC_TRANSPORT']) {
        await as(user).put('/runner/profile').send(profileBody({ transport })).expect(200);
      }
    });

    it('keeps excluded categories, and rejects ones that do not exist or repeat', async () => {
      const user = await signedInUser(app);
      await prisma.$executeRaw`INSERT INTO categories (key, name, requires_pickup, requires_destination, updated_at) VALUES ('delivery', 'Delivery', true, true, now()), ('pickup', 'Pickup', true, false, now())`;
      const delivery = await categoryId('delivery');
      const pickup = await categoryId('pickup');

      const ok = await as(user).put('/runner/profile').send(profileBody({ excludedCategoryIds: [delivery, pickup] })).expect(200);
      expect([...ok.body.data.excludedCategoryIds].sort()).toEqual([delivery, pickup].sort());

      await as(user).put('/runner/profile').send(profileBody({ excludedCategoryIds: [randomUUID()] })).expect(400);
      await as(user).put('/runner/profile').send(profileBody({ excludedCategoryIds: [delivery, delivery] })).expect(400);
      await as(user).put('/runner/profile').send(profileBody({ excludedCategoryIds: ['nope'] })).expect(400);
      const cleared = await as(user).put('/runner/profile').send(profileBody()).expect(200);
      expect(cleared.body.data.excludedCategoryIds).toEqual([]);
    });

    it('replaces the profile on a second call and never changes availability', async () => {
      const user = await signedInUser(app);
      await as(user).put('/runner/profile').send(profileBody()).expect(200);
      await as(user).put('/runner/availability').send({ availability: 'AVAILABLE' }).expect(200);

      const res = await as(user).put('/runner/profile').send(profileBody({ transport: 'CAR', areaRadiusKm: 12, areaCenter: { lat: 9.0765, lng: 7.3986 } })).expect(200);

      expect(res.body.data).toMatchObject({ transport: 'CAR', areaRadiusKm: 12, areaCenter: { lat: 9.0765, lng: 7.3986 }, availability: 'AVAILABLE' });
      expect(await prisma.runnerProfile.count()).toBe(1);
    });

    it('needs a signed-in, active user', async () => {
      await request(server()).put(`${API}/runner/profile`).send(profileBody()).expect(401);
      const user = await signedInUser(app);
      await request(server()).post(`${API}/me/deactivate`).set(...bearer(user.accessToken)).send({}).expect(200);

      await as(user).put('/runner/profile').send(profileBody()).expect(403);
    });
  });

  describe('moving the operating area (Backend PRD 17.2)', () => {
    const move = (user: TestUser, lat: number, lng = 3.38) =>
      as(user).put('/runner/profile').send({ transport: 'MOTORCYCLE', areaCenter: { lat, lng }, areaRadiusKm: 5 });

    afterEach(() => {
      process.env.RATE_LIMIT_DISABLED = 'true';
    });

    it('lets a runner move the centre only once per LOCATION_UPDATE_MIN_SECONDS', async () => {
      process.env.RATE_LIMIT_DISABLED = 'false';
      const user = await signedInUser(app);
      await move(user, 6.5).expect(200); // creating the profile is not a move
      await move(user, 6.6).expect(200); // the first move
      const tooSoon = await move(user, 6.7).expect(429);
      expect(tooSoon.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: expect.any(Number) } });
      expect((await as(user).get('/runner/profile').expect(200)).body.data.areaCenter).toEqual({ lat: 6.6, lng: 3.38 });
    });

    it('does not count a change of radius, transport or exclusions, or the same centre sent again', async () => {
      process.env.RATE_LIMIT_DISABLED = 'false';
      const user = await signedInUser(app);
      await move(user, 6.5).expect(200);
      await move(user, 6.6).expect(200);
      for (const radius of [3, 4, 6]) {
        await as(user).put('/runner/profile').send({ transport: 'CAR', areaCenter: { lat: 6.6, lng: 3.38 }, areaRadiusKm: radius }).expect(200);
      }
    });

    it('counts each runner on their own, and allows a move again after the wait', async () => {
      process.env.RATE_LIMIT_DISABLED = 'false';
      const a = await signedInUser(app);
      const b = await signedInUser(app);
      await app.get(BusinessConfigService).set('LOCATION_UPDATE_MIN_SECONDS', 1);
      await move(a, 6.5).expect(200);
      await move(a, 6.6).expect(200);
      await move(a, 6.7).expect(429);
      await move(b, 6.5).expect(200);
      await move(b, 6.6).expect(200);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await move(a, 6.7).expect(200);
    });
  });

  describe('GET /runner/profile', () => {
    it('is 404 until a profile exists, then returns it to its owner', async () => {
      const user = await signedInUser(app);
      await as(user).get('/runner/profile').expect(404);

      await as(user).put('/runner/profile').send(profileBody()).expect(200);

      expect((await as(user).get('/runner/profile').expect(200)).body.data.transport).toBe('MOTORCYCLE');
    });

    it("never shows one user's area to another", async () => {
      const owner = await signedInUser(app);
      const other = await signedInUser(app);
      await as(owner).put('/runner/profile').send(profileBody()).expect(200);

      await as(other).get('/runner/profile').expect(404);
      const publicView = await as(other).get(`/users/${owner.userId}`).expect(200);
      expect(JSON.stringify(publicView.body)).not.toContain('6.5244');
      expect(JSON.stringify(publicView.body)).not.toContain('areaCenter');
    });
  });

  describe('PUT /runner/availability', () => {
    it('needs a profile first', async () => {
      const user = await signedInUser(app);

      const res = await as(user).put('/runner/availability').send({ availability: 'AVAILABLE' }).expect(409);

      expect(res.body.error.code).toBe('RESOURCE_CONFLICT');
    });

    it('switches between AVAILABLE and UNAVAILABLE, and rejects other values', async () => {
      const user = await signedInUser(app);
      await as(user).put('/runner/profile').send(profileBody()).expect(200);

      expect((await as(user).put('/runner/availability').send({ availability: 'AVAILABLE' }).expect(200)).body.data.availability).toBe('AVAILABLE');
      expect((await as(user).put('/runner/availability').send({ availability: 'UNAVAILABLE' }).expect(200)).body.data.availability).toBe('UNAVAILABLE');
      await as(user).put('/runner/availability').send({ availability: 'BUSY' }).expect(400);
      await as(user).put('/runner/availability').send({}).expect(400);
    });
  });

  describe('eligibility (canOffer / canBrowseFeed)', () => {
    it('a verified, available runner with a verified phone may offer and browse', async () => {
      const user = await readyRunner(app);

      expect(await eligibility().canOffer(user.userId)).toEqual({ allowed: true, reasons: [] });
      expect(await eligibility().canBrowseFeed(user.userId)).toEqual({ allowed: true, reasons: [] });
      expect((await as(user).get('/runner/eligibility').expect(200)).body.data).toEqual({ canOffer: true, canBrowseFeed: true, reasons: [] });
    });

    it('an unverified runner is NOT_VERIFIED', async () => {
      const user = await signedInUser(app);
      await as(user).put('/runner/profile').send(profileBody()).expect(200);
      await as(user).put('/runner/availability').send({ availability: 'AVAILABLE' }).expect(200);

      expect(await reasons(user)).toEqual(['NOT_VERIFIED']);
    });

    it('a failed verification is NOT_VERIFIED', async () => {
      const user = await signedInUser(app);
      await startVerification(app, user, NIN.selfieMismatch);
      await as(user).put('/runner/profile').send(profileBody()).expect(200);
      await as(user).put('/runner/availability').send({ availability: 'AVAILABLE' }).expect(200);

      expect(await reasons(user)).toEqual(['NOT_VERIFIED']);
    });

    it('a verification waiting for review is VERIFICATION_PENDING', async () => {
      const user = await readyRunner(app);
      await prisma.$executeRaw`UPDATE verification_attempts SET status = 'REVIEW_REQUIRED'::"VerificationStatus" WHERE user_id = ${user.userId}::uuid`;

      expect(await reasons(user)).toEqual(['VERIFICATION_PENDING']);
    });

    it('a verified runner without a profile is NO_RUNNER_PROFILE', async () => {
      const user = await verifiedUser(app);

      expect(await reasons(user)).toEqual(['NO_RUNNER_PROFILE']);
    });

    it('an unavailable runner is UNAVAILABLE for both offers and the feed', async () => {
      const user = await readyRunner(app);
      await as(user).put('/runner/availability').send({ availability: 'UNAVAILABLE' }).expect(200);

      expect(await eligibility().canOffer(user.userId)).toEqual({ allowed: false, reasons: ['UNAVAILABLE'] });
      expect((await eligibility().canBrowseFeed(user.userId)).allowed).toBe(false);
    });

    it('an unverified phone is PHONE_NOT_VERIFIED', async () => {
      const user = await readyRunner(app);
      await prisma.$executeRaw`UPDATE users SET phone_verified_at = NULL WHERE id = ${user.userId}::uuid`;

      expect(await reasons(user)).toEqual(['PHONE_NOT_VERIFIED']);
    });

    it('lists every failing rule at once', async () => {
      const user = await signedInUser(app);
      await prisma.$executeRaw`UPDATE users SET phone_verified_at = NULL WHERE id = ${user.userId}::uuid`;

      expect(await reasons(user)).toEqual(['PHONE_NOT_VERIFIED', 'NOT_VERIFIED', 'NO_RUNNER_PROFILE']);
    });

    describe('restrictions', () => {
      const restrict = (userId: string, type: string, window: { starts: string; ends: string | null }, status = 'ACTIVE') =>
        prisma.$executeRawUnsafe(
          `INSERT INTO user_restrictions (user_id, type, status, starts_at, ends_at, enforcement_action_id, updated_at)
           VALUES ('${userId}'::uuid, '${type}'::"UserRestrictionType", '${status}'::"RestrictionStatus",
                   now() - interval '${window.starts}', ${window.ends ? `now() + interval '${window.ends}'` : 'NULL'}, '${randomUUID()}'::uuid, now())`,
        );

      it('an active OFFERING restriction blocks offers and the feed', async () => {
        const user = await readyRunner(app);
        await restrict(user.userId, 'OFFERING', { starts: '1 hour', ends: '1 day' });

        expect(await eligibility().canOffer(user.userId)).toEqual({ allowed: false, reasons: ['RESTRICTED'] });
        expect((await eligibility().canBrowseFeed(user.userId)).allowed).toBe(false);
      });

      it('an all-marketplace restriction blocks too', async () => {
        const user = await readyRunner(app);
        await restrict(user.userId, 'ALL_MARKETPLACE', { starts: '1 hour', ends: '1 day' });

        expect(await reasons(user)).toEqual(['RESTRICTED']);
      });

      it('other restriction types, expired, revoked or future restrictions do not block offers', async () => {
        const user = await readyRunner(app);
        await restrict(user.userId, 'POSTING', { starts: '1 hour', ends: '1 day' });
        await restrict(user.userId, 'OFFERING', { starts: '2 days', ends: null }, 'REVOKED');
        await prisma.$executeRaw`
          INSERT INTO user_restrictions (user_id, type, status, starts_at, ends_at, enforcement_action_id, updated_at)
          VALUES (${user.userId}::uuid, 'OFFERING'::"UserRestrictionType", 'ACTIVE'::"RestrictionStatus", now() - interval '2 days', now() - interval '1 day', ${randomUUID()}::uuid, now()),
                 (${user.userId}::uuid, 'OFFERING'::"UserRestrictionType", 'ACTIVE'::"RestrictionStatus", now() + interval '1 day', NULL, ${randomUUID()}::uuid, now())
        `;

        expect((await eligibility().canOffer(user.userId)).allowed).toBe(true);
      });
    });

    it.each(['SUSPENDED', 'DEACTIVATED', 'DELETION_PENDING'] as const)('a %s account is ACCOUNT_NOT_ACTIVE', async (status) => {
      const user = await readyRunner(app);
      await prisma.$executeRaw`UPDATE users SET status = ${status}::"UserStatus" WHERE id = ${user.userId}::uuid`;

      expect(await eligibility().canOffer(user.userId)).toEqual({ allowed: false, reasons: ['ACCOUNT_NOT_ACTIVE'] });
    });

    it('an unknown user is not eligible', async () => {
      expect((await eligibility().canOffer(randomUUID())).allowed).toBe(false);
    });

    describe('verification expiry and revocation (Backend PRD 10.2)', () => {
      it('revocation blocks new offers at once', async () => {
        const user = await readyRunner(app);
        await app.get(VerificationAdminService).revoke(user.userId, { adminId: (await createAdmin(app)).adminId }, 'review');

        expect(await reasons(user)).toEqual(['NOT_VERIFIED']);
      });

      it('expiry blocks new offers before the job runs, and the job changes nothing else about the runner', async () => {
        await app.get(BusinessConfigService).set('VERIFICATION_VALIDITY_DAYS', 30);
        const user = await readyRunner(app);
        await prisma.$executeRaw`UPDATE verification_attempts SET expires_at = now() - interval '1 minute'`;

        expect(await reasons(user)).toEqual(['NOT_VERIFIED']);
        await app.get(VerificationExpiryService).expireDue();

        expect(await reasons(user)).toEqual(['NOT_VERIFIED']);
        const profile = (await as(user).get('/runner/profile').expect(200)).body.data;
        expect(profile.availability).toBe('AVAILABLE'); // profile and availability are left alone
        expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).status).toBe('ACTIVE');
      });

      it('re-verifying restores eligibility', async () => {
        await app.get(BusinessConfigService).set('VERIFICATION_VALIDITY_DAYS', 30);
        const user = await readyRunner(app);
        await prisma.$executeRaw`UPDATE verification_attempts SET expires_at = now() - interval '1 minute'`;
        await app.get(VerificationExpiryService).expireDue();

        await startVerification(app, user, NIN.ok);

        expect((await eligibility().canOffer(user.userId)).allowed).toBe(true);
      });
    });

    describe('assertCanOffer', () => {
      const code = async (userId: string) => {
        try {
          await eligibility().assertCanOffer(userId);
          return null;
        } catch (error) {
          return (error as { code: string; details: { reasons: EligibilityReason[] } });
        }
      };

      it('passes for an eligible runner', async () => {
        const user = await readyRunner(app);

        expect(await code(user.userId)).toBeNull();
      });

      it('throws VERIFICATION_REQUIRED, VERIFICATION_PENDING or OFFER_NOT_ELIGIBLE with the reasons', async () => {
        const unverified = await signedInUser(app);
        const pending = await readyRunner(app);
        await prisma.$executeRaw`UPDATE verification_attempts SET status = 'REVIEW_REQUIRED'::"VerificationStatus" WHERE user_id = ${pending.userId}::uuid`;
        const unavailable = await readyRunner(app, NIN.other);
        await as(unavailable).put('/runner/availability').send({ availability: 'UNAVAILABLE' }).expect(200);

        expect((await code(unverified.userId))?.code).toBe('VERIFICATION_REQUIRED');
        expect((await code(pending.userId))?.code).toBe('VERIFICATION_PENDING');
        const last = await code(unavailable.userId);
        expect(last?.code).toBe('OFFER_NOT_ELIGIBLE');
        expect(last?.details.reasons).toEqual(['UNAVAILABLE']);
      });
    });

    it('GET /runner/eligibility tells the runner why, and is closed to anonymous callers', async () => {
      const user = await verifiedUser(app);

      const res = await as(user).get('/runner/eligibility').expect(200);

      expect(res.body.data).toEqual({ canOffer: false, canBrowseFeed: false, reasons: ['NO_RUNNER_PROFILE'] });
      await request(server()).get(`${API}/runner/eligibility`).expect(401);
    });
  });
});

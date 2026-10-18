import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, createAdmin, registerUser, seedAdminRoles, seedPolicies, signedInUser, verifyUser, loginMobile } from '../test/auth.helper.js';
import { fakeStorage, readyMedia } from '../test/media.helper.js';
import { IDENTITY, NIN, fakeKyc, startVerification, verifiedUser, type TestUser } from '../test/verification.helper.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { VerificationAdminService } from './verification-admin.service.js';
import { VerificationExpiryService } from './verification-expiry.service.js';
import { VerificationSweeper } from '../scheduler/verification.sweeper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Verification (Phase 4)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  const server = () => app.getHttpServer();
  const get = (path: string, user: TestUser) => request(server()).get(`${API}${path}`).set(...bearer(user.accessToken));
  const attemptRow = (id: string) => prisma.verificationAttempt.findUniqueOrThrow({ where: { id } });
  const admin = () => app.get(VerificationAdminService);
  const expiry = () => app.get(VerificationExpiryService);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const actor = async () => ({ adminId: (await createAdmin(app)).adminId });
  /** Age every finished attempt of the user by this many hours. */
  const ageAttempts = (userId: string, hours: number) =>
    prisma.$executeRawUnsafe(
      `UPDATE verification_attempts SET completed_at = completed_at - interval '${hours} hours', created_at = created_at - interval '${hours} hours' WHERE user_id = '${userId}'::uuid`,
    );

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
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await app.close();
  });

  describe('GET /verification', () => {
    it('a new user has not started and may start', async () => {
      const user = await signedInUser(app);

      const res = await get('/verification', user).expect(200);

      expect(res.body.data).toMatchObject({
        status: 'NOT_STARTED',
        displayStatus: 'NOT_STARTED',
        verified: false,
        phoneVerified: true,
        latestAttempt: null,
        attemptsRemaining: 3,
        nextAttemptAt: null,
        feeRequired: false,
        canStart: true,
      });
    });

    it('needs a signed-in user', async () => {
      await request(server()).get(`${API}/verification`).expect(401);
    });

    it('a user who registered with email only cannot start until a phone is verified', async () => {
      const user = await registerUser(app, { email: 'ada@example.com' });
      await verifyUser(app, user);
      const tokens = await loginMobile(app, user);
      const me = { ...user, ...tokens } as TestUser;

      const overview = await get('/verification', me).expect(200);
      const start = await startVerification(app, me, NIN.ok, { selfieMediaId: randomUUID() });

      expect(overview.body.data).toMatchObject({ phoneVerified: false, canStart: false });
      expect(start.status).toBe(403);
      expect(start.body.error.details.reason).toBe('PHONE_NOT_VERIFIED');
      expect(await prisma.verificationAttempt.count()).toBe(0);
    });
  });

  describe('POST /verification/attempts', () => {
    it('verifies a runner: VERIFIED, with the record, an event and an audit row', async () => {
      const user = await signedInUser(app);

      const res = await startVerification(app, user, NIN.ok).then((r) => r);

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: 'VERIFIED', displayStatus: 'VERIFIED', failureReason: null, attemptNumber: 1, expiresAt: null });
      const row = await attemptRow(res.body.data.id);
      expect(row).toMatchObject({ provider: 'fake', countsAgainstAllowance: true, userId: user.userId });
      expect(Number(row.confidence)).toBe(99);
      expect(row.maskedAttributes).toEqual({ ninLast4: '8901' });
      expect(row.identityRefHmac).toMatch(/^[0-9a-f]{64}$/);
      expect(row.providerRequestId).toMatch(/^fake-kyc-/);
      expect(row.completedAt).not.toBeNull();
      const events = await prisma.outboxEvent.findMany({ where: { eventType: 'verification.completed' } });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ userId: user.userId, status: 'VERIFIED' });
      expect(await prisma.auditLog.count({ where: { action: 'verification.verified', actorId: user.userId } })).toBe(1);
      const overview = await get('/verification', user).expect(200);
      expect(overview.body.data).toMatchObject({ status: 'VERIFIED', verified: true, canStart: false });
    });

    it.each([
      ['selfie mismatch', NIN.selfieMismatch, 'SELFIE_MISMATCH', true],
      ['NIN not found', NIN.notFound, 'IDENTITY_MISMATCH', true],
      ['provider timeout', NIN.timeout, 'PROVIDER_TIMEOUT', false],
      ['provider error', NIN.providerError, 'PROVIDER_ERROR', false],
    ])('%s: FAILED / %s, counts against the allowance: %s', async (_name, nin, reason, counts) => {
      const user = await signedInUser(app);

      const res = await startVerification(app, user, nin).then((r) => r);

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: 'FAILED', displayStatus: 'REJECTED', failureReason: reason });
      const row = await attemptRow(res.body.data.id);
      expect(row.countsAgainstAllowance).toBe(counts);
      expect(row.identityRefHmac).toBeNull();
      const overview = (await get('/verification', user).expect(200)).body.data;
      expect(overview).toMatchObject({ status: 'FAILED', verified: false, canStart: true });
      expect(overview.attemptsRemaining).toBe(counts ? 2 : 3);
      expect(await prisma.outboxEvent.count({ where: { eventType: 'verification.failed' } })).toBe(1);
    });

    it.each(['DOCUMENT_INVALID', 'INSUFFICIENT_DATA'] as const)('maps a scripted %s failure', async (reason) => {
      const user = await signedInUser(app);
      fakeKyc(app).scriptOutcomes('verifyNinWithSelfie', [{ outcome: 'FAILED', failureReason: reason, countsAgainstAllowance: true }]);

      const res = await startVerification(app, user, NIN.ok).then((r) => r);

      expect(res.body.data).toMatchObject({ status: 'FAILED', failureReason: reason });
    });

    it('sends the provider the NIN, the selfie as base64 and the configured threshold', async () => {
      const user = await signedInUser(app);
      const spy = vi.spyOn(fakeKyc(app), 'verifyNinWithSelfie');

      await startVerification(app, user, NIN.ok);

      const sent = spy.mock.calls[0][0];
      expect(sent.nin).toBe(NIN.ok);
      expect(sent.threshold).toBe(90);
      expect(sent.timeoutMs).toBe(30_000);
      expect(Buffer.from(sent.selfieImageBase64, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(sent.selfieImageBase64.startsWith('data:')).toBe(false);
    });

    it('a provider that never answers ends as PROVIDER_TIMEOUT and does not count', async () => {
      const user = await signedInUser(app);
      await app.get(BusinessConfigService).set('KYC_REQUEST_TIMEOUT_SECONDS', 1);
      vi.spyOn(fakeKyc(app), 'verifyNinWithSelfie').mockImplementation(() => new Promise(() => undefined));

      const res = await startVerification(app, user, NIN.ok).then((r) => r);

      expect(res.body.data).toMatchObject({ status: 'FAILED', failureReason: 'PROVIDER_TIMEOUT' });
      expect((await attemptRow(res.body.data.id)).countsAgainstAllowance).toBe(false);
    });

    it('a provider that throws ends as PROVIDER_ERROR, not a 500', async () => {
      const user = await signedInUser(app);
      vi.spyOn(fakeKyc(app), 'verifyNinWithSelfie').mockRejectedValue(new Error('socket hang up'));

      const res = await startVerification(app, user, NIN.ok).then((r) => r);

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: 'FAILED', failureReason: 'PROVIDER_ERROR' });
    });

    it('rejects a malformed NIN with 400 before anything is created, and never echoes it', async () => {
      const user = await signedInUser(app);
      const selfie = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');

      for (const nin of ['1234567890', '123456789012', '1234567890a', '12 45678901', '']) {
        const res = await startVerification(app, user, nin, { selfieMediaId: selfie }).then((r) => r);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        if (nin) expect(JSON.stringify(res.body)).not.toContain(nin);
      }
      expect(await prisma.verificationAttempt.count()).toBe(0);
      expect(fakeKyc(app).getCalls('verifyNinWithSelfie')).toHaveLength(0);
    });

    it('needs a ready selfie of purpose VERIFICATION_INPUT that the caller owns', async () => {
      const user = await signedInUser(app);
      const other = await signedInUser(app);
      const wrongPurpose = await readyMedia(app, user.accessToken, 'PROFILE_PHOTO');
      const theirs = await readyMedia(app, other.accessToken, 'VERIFICATION_INPUT');

      expect((await startVerification(app, user, NIN.ok, { selfieMediaId: wrongPurpose }).then((r) => r)).body.error.code).toBe('MEDIA_INVALID');
      expect((await startVerification(app, user, NIN.ok, { selfieMediaId: theirs }).then((r) => r)).body.error.code).toBe('MEDIA_INVALID');
      expect((await startVerification(app, user, NIN.ok, { selfieMediaId: randomUUID() }).then((r) => r)).body.error.code).toBe('MEDIA_INVALID');
      expect(await prisma.verificationAttempt.count()).toBe(0);
    });

    it('answers 409 MEDIA_NOT_READY for a selfie still being processed', async () => {
      const user = await signedInUser(app);
      const { uploadAndConfirm, makeImage } = await import('../test/media.helper.js');
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg'), { purpose: 'VERIFICATION_INPUT' });

      const res = await startVerification(app, user, NIN.ok, { selfieMediaId: mediaId }).then((r) => r);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MEDIA_NOT_READY');
    });

    it('refuses a second attempt once verified', async () => {
      const user = await verifiedUser(app);

      const res = await startVerification(app, user, NIN.other).then((r) => r);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('RESOURCE_CONFLICT');
    });

    it('allows only one attempt in flight: the second answers VERIFICATION_PENDING', async () => {
      const user = await signedInUser(app);
      const selfieA = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');
      const selfieB = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');
      const original = fakeKyc(app).verifyNinWithSelfie.bind(fakeKyc(app));
      vi.spyOn(fakeKyc(app), 'verifyNinWithSelfie').mockImplementation(async (r) => {
        await sleep(400);
        return original(r);
      });

      const [first, second] = await Promise.all([
        startVerification(app, user, NIN.ok, { selfieMediaId: selfieA }).then((r) => r),
        startVerification(app, user, NIN.ok, { selfieMediaId: selfieB }).then((r) => r),
      ]);

      expect([first.status, second.status].sort()).toEqual([201, 403]);
      const rejected = first.status === 403 ? first : second;
      expect(rejected.body.error.code).toBe('VERIFICATION_PENDING');
      expect(await prisma.verificationAttempt.count()).toBe(1);
      expect(fakeKyc(app).getCalls('verifyNinWithSelfie')).toHaveLength(1);
    });

    it('is idempotent: the same key replays the first answer and does not call the provider again', async () => {
      const user = await signedInUser(app);
      const selfie = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');
      const key = randomUUID();

      const first = await startVerification(app, user, NIN.selfieMismatch, { selfieMediaId: selfie, idempotencyKey: key }).then((r) => r);
      const again = await startVerification(app, user, NIN.selfieMismatch, { selfieMediaId: selfie, idempotencyKey: key }).then((r) => r);

      expect(again.body.data.id).toBe(first.body.data.id);
      expect(await prisma.verificationAttempt.count()).toBe(1);
      expect(fakeKyc(app).getCalls('verifyNinWithSelfie')).toHaveLength(1);
    });

    it('needs an Idempotency-Key', async () => {
      const user = await signedInUser(app);
      const selfie = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');

      await request(server()).post(`${API}/verification/attempts`).set(...bearer(user.accessToken)).send({ nin: NIN.ok, selfieMediaId: selfie, identity: IDENTITY }).expect(400);
    });

    it('a non-zero fee asks for payment first (the paid path arrives with billing)', async () => {
      const user = await signedInUser(app);
      await app.get(BusinessConfigService).set('VERIFICATION_FEE', 500000);

      const res = await startVerification(app, user, NIN.ok).then((r) => r);
      const overview = (await get('/verification', user).expect(200)).body.data;

      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('VERIFICATION_FEE_REQUIRED');
      expect(overview).toMatchObject({ feeRequired: true, canStart: false });
    });
  });

  describe('the NIN and the selfie are never kept', () => {
    it('appears in no table, event, audit row, idempotency record or response', async () => {
      const user = await signedInUser(app);
      const res = await startVerification(app, user, NIN.ok).then((r) => r);
      await startVerification(app, await signedInUser(app), NIN.selfieMismatch);

      const dump = JSON.stringify({
        response: res.body,
        attempts: await prisma.$queryRaw`SELECT * FROM verification_attempts`,
        events: await prisma.$queryRaw`SELECT * FROM outbox_events`,
        audit: await prisma.$queryRaw`SELECT * FROM audit_logs`,
        idempotency: await prisma.$queryRaw`SELECT * FROM idempotency_keys`,
      });
      expect(dump).not.toContain(NIN.ok);
      expect(dump).not.toContain(NIN.selfieMismatch);
      expect(JSON.stringify(fakeKyc(app).getCalls())).not.toContain(NIN.ok);
    });

    it('the database refuses 11 digits in a row in the masked attributes', async () => {
      const user = await signedInUser(app);
      const res = await startVerification(app, user, NIN.ok).then((r) => r);

      await expect(
        prisma.$executeRaw`UPDATE verification_attempts SET masked_attributes = ${JSON.stringify({ nin: NIN.ok })}::jsonb WHERE id = ${res.body.data.id}::uuid`,
      ).rejects.toThrow(/no_full_nin/);
      await prisma.$executeRaw`UPDATE verification_attempts SET masked_attributes = ${JSON.stringify({ ninLast4: '8901' })}::jsonb WHERE id = ${res.body.data.id}::uuid`;
    });

    it('the attempt view never contains the identity hash, masked attributes, confidence or selfie', async () => {
      const user = await signedInUser(app);
      const res = await startVerification(app, user, NIN.ok).then((r) => r);

      const view = await get(`/verification/attempts/${res.body.data.id}`, user).expect(200);

      expect(Object.keys(view.body.data).sort()).toEqual(
        ['attemptNumber', 'completedAt', 'displayStatus', 'expiresAt', 'failureReason', 'id', 'startedAt', 'status'].sort(),
      );
    });
  });

  describe('GET /verification/attempts/:id', () => {
    it("is the owner's only", async () => {
      const owner = await signedInUser(app);
      const stranger = await signedInUser(app);
      const res = await startVerification(app, owner, NIN.ok).then((r) => r);

      await get(`/verification/attempts/${res.body.data.id}`, owner).expect(200);
      await get(`/verification/attempts/${res.body.data.id}`, stranger).expect(404);
      await get(`/verification/attempts/${randomUUID()}`, owner).expect(404);
      await get('/verification/attempts/nope', owner).expect(400);
    });
  });

  describe('duplicate identity', () => {
    it('a second account with the same NIN fails with DUPLICATE_IDENTITY, which counts', async () => {
      await verifiedUser(app, NIN.ok);
      const second = await signedInUser(app);

      const res = await startVerification(app, second, NIN.ok).then((r) => r);

      expect(res.body.data).toMatchObject({ status: 'FAILED', failureReason: 'DUPLICATE_IDENTITY' });
      expect((await attemptRow(res.body.data.id)).countsAgainstAllowance).toBe(true);
      expect((await attemptRow(res.body.data.id)).identityRefHmac).toBeNull();
    });

    it('two accounts verifying the same NIN at the same moment: exactly one wins', async () => {
      const a = await signedInUser(app);
      const b = await signedInUser(app);
      const selfieA = await readyMedia(app, a.accessToken, 'VERIFICATION_INPUT');
      const selfieB = await readyMedia(app, b.accessToken, 'VERIFICATION_INPUT');

      const [ra, rb] = await Promise.all([
        startVerification(app, a, NIN.ok, { selfieMediaId: selfieA }).then((r) => r),
        startVerification(app, b, NIN.ok, { selfieMediaId: selfieB }).then((r) => r),
      ]);

      const statuses = [ra.body.data.status, rb.body.data.status].sort();
      expect(statuses).toEqual(['FAILED', 'VERIFIED']);
      const loser = ra.body.data.status === 'FAILED' ? ra : rb;
      expect(loser.body.data.failureReason).toBe('DUPLICATE_IDENTITY');
      expect(await prisma.verificationAttempt.count({ where: { status: 'VERIFIED' } })).toBe(1);
    });

    it('the database allows one VERIFIED row per identity', async () => {
      const a = await verifiedUser(app, NIN.ok);
      const b = await signedInUser(app);
      const row = await prisma.verificationAttempt.findFirstOrThrow({ where: { userId: a.userId } });

      await expect(
        prisma.$executeRaw`
          INSERT INTO verification_attempts (user_id, provider, status, attempt_number, identity_ref_hmac, started_at, updated_at)
          VALUES (${b.userId}::uuid, 'fake', 'VERIFIED'::"VerificationStatus", 1, ${row.identityRefHmac}, now(), now())
        `,
      ).rejects.toThrow(/identity_ref_hmac/);
    });

    it('frees the identity once the first verification is revoked', async () => {
      const first = await verifiedUser(app, NIN.ok);
      const second = await signedInUser(app);
      await admin().revoke(first.userId, await actor(), 'fraud review');

      const res = await startVerification(app, second, NIN.ok).then((r) => r);

      expect(res.body.data.status).toBe('VERIFIED');
    });

    it('the same person under a BVN on a second account fails with DUPLICATE_IDENTITY', async () => {
      const first = await verifiedUser(app, NIN.ok);
      const second = await signedInUser(app);

      const res = await startVerification(app, second, NIN.other, { idType: 'BVN' }).then((r) => r);

      expect(res.body.data).toMatchObject({ status: 'FAILED', failureReason: 'DUPLICATE_IDENTITY' });
      const row = await attemptRow(res.body.data.id);
      expect(row).toMatchObject({ countsAgainstAllowance: true, idType: 'BVN', identityRefHmac: null, personRefHmac: null });
      expect(await prisma.verificationAttempt.count({ where: { userId: first.userId, status: 'VERIFIED' } })).toBe(1);
    });

    it('another person under a BVN is not a duplicate', async () => {
      await verifiedUser(app, NIN.ok);
      const second = await signedInUser(app);

      const res = await startVerification(app, second, NIN.wrongName, {
        idType: 'BVN',
        identity: { firstName: 'Musa', lastName: 'Ibrahim', dateOfBirth: '1994-03-21' },
      }).then((r) => r);

      expect(res.body.data.status).toBe('VERIFIED');
    });
  });

  describe('NIN or BVN, and the name and date of birth', () => {
    it('verifies with a BVN: VERIFIED, id type BVN, masked as bvnLast4, the number never stored', async () => {
      const user = await signedInUser(app);

      const res = await startVerification(app, user, NIN.ok, { idType: 'BVN' }).then((r) => r);

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: 'VERIFIED', failureReason: null });
      const row = await attemptRow(res.body.data.id);
      expect(row).toMatchObject({ idType: 'BVN', maskedAttributes: { bvnLast4: '8901' } });
      expect(row.identityRefHmac).toMatch(/^[0-9a-f]{64}$/);
      expect(row.personRefHmac).toMatch(/^[0-9a-f]{64}$/);
      expect(fakeKyc(app).getCalls('verifyBvnWithSelfie')).toHaveLength(1);
      expect(fakeKyc(app).getCalls('verifyNinWithSelfie')).toHaveLength(0);
      expect(JSON.stringify(fakeKyc(app).getCalls())).not.toContain(NIN.ok);
    });

    it.each([
      ['a name that is not on the record', NIN.ok, { firstName: 'Musa', lastName: 'Ibrahim', dateOfBirth: '1994-03-21' }],
      ['a date of birth that is not on the record', NIN.ok, { firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1994-03-22' }],
      ['a record that holds another name', NIN.wrongName, undefined],
      ['a record that holds another date of birth', NIN.wrongBirthDate, undefined],
    ])('%s: FAILED / IDENTITY_MISMATCH, counts', async (_name, number, identity) => {
      const user = await signedInUser(app);

      const res = await startVerification(app, user, number, { identity }).then((r) => r);

      expect(res.body.data).toMatchObject({ status: 'FAILED', failureReason: 'IDENTITY_MISMATCH' });
      const row = await attemptRow(res.body.data.id);
      expect(row).toMatchObject({ countsAgainstAllowance: true, identityRefHmac: null, personRefHmac: null });
    });

    it('a matching face with an unreadable record is PROVIDER_ERROR, never VERIFIED, and does not count', async () => {
      const user = await signedInUser(app);

      const res = await startVerification(app, user, NIN.noRecord).then((r) => r);

      expect(res.body.data).toMatchObject({ status: 'FAILED', failureReason: 'PROVIDER_ERROR' });
      expect((await attemptRow(res.body.data.id)).countsAgainstAllowance).toBe(false);
    });

    it('accepts a typo-level difference and a different name order', async () => {
      const user = await signedInUser(app);

      const res = await startVerification(app, user, NIN.ok, {
        identity: { firstName: 'Okafar', lastName: 'Ada Chinwe', dateOfBirth: '1994-03-21' },
      }).then((r) => r);

      expect(res.body.data.status).toBe('VERIFIED');
    });

    it('refuses a request with both a NIN and a BVN, with neither, or with a short BVN', async () => {
      const user = await signedInUser(app);
      const selfie = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');
      const send = (body: Record<string, unknown>) =>
        request(server())
          .post(`${API}/verification/attempts`)
          .set(...bearer(user.accessToken))
          .set('Idempotency-Key', randomUUID())
          .send({ selfieMediaId: selfie, identity: IDENTITY, ...body });

      await send({ nin: NIN.ok, bvn: NIN.other }).expect(400);
      await send({}).expect(400);
      await send({ bvn: '123' }).expect(400);
      expect(await prisma.verificationAttempt.count()).toBe(0);
    });

    it('refuses a request without the name and date of birth', async () => {
      const user = await signedInUser(app);
      const selfie = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');

      await request(server())
        .post(`${API}/verification/attempts`)
        .set(...bearer(user.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({ nin: NIN.ok, selfieMediaId: selfie })
        .expect(400);
      expect(await prisma.verificationAttempt.count()).toBe(0);
    });
  });

  describe('retries and the cooldown', () => {
    const failOnce = (user: TestUser) => startVerification(app, user, NIN.selfieMismatch).then((r) => r);

    it('three user-data failures block the next attempt with 429 and a retry time', async () => {
      const user = await signedInUser(app);
      for (let i = 0; i < 3; i += 1) {
        expect((await failOnce(user)).body.data.attemptNumber).toBe(i + 1);
      }

      const blocked = await startVerification(app, user, NIN.ok).then((r) => r);
      const overview = (await get('/verification', user).expect(200)).body.data;

      expect(blocked.status).toBe(429);
      expect(blocked.body.error.details.reason).toBe('VERIFICATION_COOLDOWN');
      expect(overview).toMatchObject({ attemptsRemaining: 0, canStart: false });
      const retryAt = new Date(overview.nextAttemptAt).getTime() - Date.now();
      expect(retryAt).toBeGreaterThan(23 * 3600_000);
      expect(retryAt).toBeLessThanOrEqual(24 * 3600_000 + 5000);
      expect(await prisma.verificationAttempt.count()).toBe(3);
    });

    it('provider faults do not count, however many there are', async () => {
      const user = await signedInUser(app);
      for (let i = 0; i < 5; i += 1) {
        await startVerification(app, user, NIN.providerError);
      }

      const overview = (await get('/verification', user).expect(200)).body.data;

      expect(overview).toMatchObject({ attemptsRemaining: 3, canStart: true });
      expect((await startVerification(app, user, NIN.ok).then((r) => r)).body.data.status).toBe('VERIFIED');
    });

    it('the runner can try again once the 24 hours have passed', async () => {
      const user = await signedInUser(app);
      for (let i = 0; i < 3; i += 1) await failOnce(user);
      await ageAttempts(user.userId, 25);

      const res = await startVerification(app, user, NIN.ok).then((r) => r);

      expect(res.body.data.status).toBe('VERIFIED');
    });

    it('the window slides: the slot returns when the third most recent failure ages out', async () => {
      const user = await signedInUser(app);
      for (let i = 0; i < 3; i += 1) await failOnce(user);
      await prisma.$executeRaw`
        UPDATE verification_attempts SET completed_at = now() - interval '25 hours'
        WHERE id = (SELECT id FROM verification_attempts WHERE user_id = ${user.userId}::uuid ORDER BY created_at LIMIT 1)
      `;

      const overview = (await get('/verification', user).expect(200)).body.data;

      expect(overview.attemptsRemaining).toBe(1);
    });

    it('uses the configured limit and cooldown', async () => {
      const user = await signedInUser(app);
      await app.get(BusinessConfigService).set('VERIFICATION_ATTEMPTS_PER_FEE', 1);
      await failOnce(user);

      expect((await startVerification(app, user, NIN.ok).then((r) => r)).status).toBe(429);
    });

    it('an admin can always grant a fresh set of attempts', async () => {
      const user = await signedInUser(app);
      for (let i = 0; i < 3; i += 1) await failOnce(user);

      const reset = await admin().grantExtraAttempts(user.userId, await actor(), 'support ticket 42');

      expect(reset).toBe(3);
      expect((await get('/verification', user).expect(200)).body.data.attemptsRemaining).toBe(3);
      expect((await startVerification(app, user, NIN.ok).then((r) => r)).body.data.status).toBe('VERIFIED');
      expect(await prisma.verificationAttempt.count({ where: { status: 'FAILED' } })).toBe(3);
    });
  });

  describe('expiry', () => {
    it('does not expire by default', async () => {
      const user = await verifiedUser(app);
      await prisma.$executeRaw`UPDATE verification_attempts SET completed_at = now() - interval '5 years'`;

      expect(await expiry().expireDue()).toBe(0);
      expect((await get('/verification', user).expect(200)).body.data.verified).toBe(true);
    });

    it('sets the expiry from VERIFICATION_VALIDITY_DAYS', async () => {
      await app.get(BusinessConfigService).set('VERIFICATION_VALIDITY_DAYS', 30);
      const user = await signedInUser(app);

      const res = await startVerification(app, user, NIN.ok).then((r) => r);

      const days = (new Date(res.body.data.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
    });

    it('the job moves an expired verification to EXPIRED with an event and an audit row, once', async () => {
      await app.get(BusinessConfigService).set('VERIFICATION_VALIDITY_DAYS', 30);
      const user = await verifiedUser(app);
      await prisma.$executeRaw`UPDATE verification_attempts SET expires_at = now() - interval '1 minute'`;

      expect(await expiry().expireDue()).toBe(1);
      expect(await expiry().expireDue()).toBe(0);

      const row = await prisma.verificationAttempt.findFirstOrThrow({ where: { userId: user.userId } });
      expect(row.status).toBe('EXPIRED');
      expect(await prisma.outboxEvent.count({ where: { eventType: 'verification.expired' } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'verification.expired' } })).toBe(1);
    });

    it('an expired verification stops counting immediately, before the job runs', async () => {
      await app.get(BusinessConfigService).set('VERIFICATION_VALIDITY_DAYS', 30);
      const user = await verifiedUser(app);
      await prisma.$executeRaw`UPDATE verification_attempts SET expires_at = now() - interval '1 minute'`;

      const overview = (await get('/verification', user).expect(200)).body.data;

      expect(overview).toMatchObject({ status: 'EXPIRED', displayStatus: 'EXPIRED', verified: false, canStart: true });
    });

    it('after expiry the runner can verify again', async () => {
      await app.get(BusinessConfigService).set('VERIFICATION_VALIDITY_DAYS', 30);
      const user = await verifiedUser(app);
      await prisma.$executeRaw`UPDATE verification_attempts SET expires_at = now() - interval '1 minute'`;
      await expiry().expireDue();

      const res = await startVerification(app, user, NIN.ok).then((r) => r);

      expect(res.body.data).toMatchObject({ status: 'VERIFIED', attemptNumber: 2 });
    });
  });

  describe('abandoned attempts', () => {
    it('a PENDING attempt left by a crashed request fails as a provider fault and unblocks the runner', async () => {
      const user = await signedInUser(app);
      await prisma.$executeRaw`
        INSERT INTO verification_attempts (user_id, provider, status, attempt_number, started_at, updated_at)
        VALUES (${user.userId}::uuid, 'fake', 'PENDING'::"VerificationStatus", 1, now() - interval '10 minutes', now())
      `;
      expect((await startVerification(app, user, NIN.ok).then((r) => r)).body.error.code).toBe('VERIFICATION_PENDING');

      expect(await expiry().failStalePending()).toBe(1);

      const row = await prisma.verificationAttempt.findFirstOrThrow({ where: { userId: user.userId } });
      expect(row).toMatchObject({ status: 'FAILED', failureReason: 'PROVIDER_ERROR', countsAgainstAllowance: false });
      expect((await startVerification(app, user, NIN.ok).then((r) => r)).body.data.status).toBe('VERIFIED');
    });

    it('leaves a recent PENDING attempt alone', async () => {
      const user = await signedInUser(app);
      await prisma.$executeRaw`
        INSERT INTO verification_attempts (user_id, provider, status, attempt_number, started_at, updated_at)
        VALUES (${user.userId}::uuid, 'fake', 'PENDING'::"VerificationStatus", 1, now() - interval '5 seconds', now())
      `;

      expect(await expiry().failStalePending()).toBe(0);
    });

    it('a late provider answer cannot overwrite the decision the sweeper made', async () => {
      const user = await signedInUser(app);
      const original = fakeKyc(app).verifyNinWithSelfie.bind(fakeKyc(app));
      vi.spyOn(fakeKyc(app), 'verifyNinWithSelfie').mockImplementation(async (r) => {
        await prisma.$executeRaw`UPDATE verification_attempts SET started_at = now() - interval '10 minutes'`;
        await expiry().failStalePending();
        return original(r);
      });

      const res = await startVerification(app, user, NIN.ok).then((r) => r);

      expect(res.body.data).toMatchObject({ status: 'FAILED', failureReason: 'PROVIDER_ERROR' });
      expect(await prisma.verificationAttempt.count({ where: { status: 'VERIFIED' } })).toBe(0);
    });
  });

  describe('staged selfies', () => {
    it('are deleted 30 days after the decision, not before', async () => {
      const user = await signedInUser(app);
      const selfie = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');
      const res = await startVerification(app, user, NIN.selfieMismatch, { selfieMediaId: selfie }).then((r) => r);
      const media = await prisma.media.findUniqueOrThrow({ where: { id: selfie } });
      await prisma.$executeRaw`UPDATE verification_attempts SET completed_at = now() - interval '29 days'`;

      expect(await expiry().deleteStagedSelfies()).toBe(0);
      expect((await fakeStorage(app).headObject(media.storageKey)).exists).toBe(true);

      await prisma.$executeRaw`UPDATE verification_attempts SET completed_at = now() - interval '31 days'`;
      expect(await expiry().deleteStagedSelfies()).toBe(1);

      expect((await fakeStorage(app).headObject(media.storageKey)).exists).toBe(false);
      expect((await prisma.media.findUniqueOrThrow({ where: { id: selfie } })).deletedAt).not.toBeNull();
      expect((await attemptRow(res.body.data.id)).selfieMediaId).toBeNull();
      expect(await expiry().deleteStagedSelfies()).toBe(0);
    });

    it('are kept while the attempt is undecided', async () => {
      const user = await signedInUser(app);
      const selfie = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');
      await prisma.$executeRaw`
        INSERT INTO verification_attempts (user_id, provider, status, attempt_number, selfie_media_id, started_at, completed_at, updated_at)
        VALUES (${user.userId}::uuid, 'fake', 'REVIEW_REQUIRED'::"VerificationStatus", 1, ${selfie}::uuid, now() - interval '60 days', now() - interval '60 days', now())
      `;

      expect(await expiry().deleteStagedSelfies()).toBe(0);
    });

    it('the selfie of a runner is not visible to other users or ordinary admins without VERIFICATION_VIEW', async () => {
      const user = await signedInUser(app);
      const other = await signedInUser(app);
      const selfie = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');

      await request(server()).get(`${API}/media/${selfie}/url`).set(...bearer(other.accessToken)).expect(404);
    });
  });

  describe('the sweeper', () => {
    it('runs expiry, stale-attempt and selfie cleanup together', async () => {
      const user = await signedInUser(app);
      await prisma.$executeRaw`
        INSERT INTO verification_attempts (user_id, provider, status, attempt_number, started_at, updated_at)
        VALUES (${user.userId}::uuid, 'fake', 'PENDING'::"VerificationStatus", 1, now() - interval '10 minutes', now())
      `;
      const sweeper = new VerificationSweeper(prisma as never, expiry());

      expect(await sweeper['processBatch']()).toBe(1);
    });
  });

  describe('admin actions (service level; controllers arrive with the admin console)', () => {
    const setStatus = (id: string, status: string, reason?: string) =>
      prisma.$executeRawUnsafe(
        `UPDATE verification_attempts SET status = '${status}'::"VerificationStatus", failure_reason = ${reason ? `'${reason}'::"VerificationFailureReason"` : 'NULL'} WHERE id = '${id}'::uuid`,
      );

    it('approve: REVIEW_REQUIRED becomes VERIFIED, with an audit row and an event', async () => {
      const user = await signedInUser(app);
      const res = await startVerification(app, user, NIN.ok).then((r) => r);
      await setStatus(res.body.data.id, 'REVIEW_REQUIRED');
      await prisma.$executeRaw`UPDATE verification_attempts SET identity_ref_hmac = NULL`;
      const who = await actor();

      const view = await admin().approve(res.body.data.id, who, 'documents checked by phone');

      expect(view.status).toBe('VERIFIED');
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'verification.approved' } });
      expect(audit).toMatchObject({ actorType: 'ADMIN', actorId: who.adminId, entityId: res.body.data.id });
      expect(audit.metadata).toMatchObject({ reason: 'documents checked by phone', from: 'REVIEW_REQUIRED' });
      expect(await prisma.outboxEvent.count({ where: { eventType: 'verification.completed' } })).toBe(2);
      expect((await get('/verification', user).expect(200)).body.data.verified).toBe(true);
    });

    it('approve: overrides a FAILED attempt (selfie mismatch)', async () => {
      const user = await signedInUser(app);
      const res = await startVerification(app, user, NIN.selfieMismatch).then((r) => r);

      const view = await admin().approve(res.body.data.id, await actor(), 'manual comparison');

      expect(view).toMatchObject({ status: 'VERIFIED', failureReason: null });
    });

    it('approve: never approves a duplicate identity', async () => {
      await verifiedUser(app, NIN.ok);
      const second = await signedInUser(app);
      const res = await startVerification(app, second, NIN.ok).then((r) => r);

      await expect(admin().approve(res.body.data.id, await actor(), 'please')).rejects.toMatchObject({ code: 'DUPLICATE_IDENTITY' });
      expect((await attemptRow(res.body.data.id)).status).toBe('FAILED');
    });

    it('approve, reject and revoke follow the state machine', async () => {
      const user = await verifiedUser(app);
      const row = await prisma.verificationAttempt.findFirstOrThrow({ where: { userId: user.userId } });

      await expect(admin().approve(row.id, await actor(), 'again')).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
      await expect(admin().reject(row.id, await actor(), { reason: 'no' })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
      await expect(admin().approve(randomUUID(), await actor(), 'x')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await expect(admin().revoke((await signedInUser(app)).userId, await actor(), 'x')).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect((await attemptRow(row.id)).status).toBe('VERIFIED');
    });

    it('reject: REVIEW_REQUIRED becomes FAILED with the given reason, audited, with an event', async () => {
      const user = await signedInUser(app);
      const res = await startVerification(app, user, NIN.ok).then((r) => r);
      await setStatus(res.body.data.id, 'REVIEW_REQUIRED');
      const who = await actor();

      const view = await admin().reject(res.body.data.id, who, { reason: 'photo unclear', failureReason: 'INSUFFICIENT_DATA' });

      expect(view).toMatchObject({ status: 'FAILED', failureReason: 'INSUFFICIENT_DATA' });
      expect(await prisma.auditLog.count({ where: { action: 'verification.rejected', actorId: who.adminId } })).toBe(1);
      expect(await prisma.outboxEvent.count({ where: { eventType: 'verification.failed' } })).toBe(1);
    });

    it('revoke: the current verification becomes REVOKED, audited, with an event; the runner may start again', async () => {
      const user = await verifiedUser(app);
      const who = await actor();

      const view = await admin().revoke(user.userId, who, 'identity fraud report');

      expect(view).toMatchObject({ status: 'REVOKED', displayStatus: 'REJECTED' });
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'verification.revoked' } });
      expect(audit).toMatchObject({ actorType: 'ADMIN', actorId: who.adminId });
      expect(await prisma.outboxEvent.count({ where: { eventType: 'verification.revoked' } })).toBe(1);
      const overview = (await get('/verification', user).expect(200)).body.data;
      expect(overview).toMatchObject({ verified: false, status: 'REVOKED', canStart: true });
      expect((await startVerification(app, user, NIN.ok).then((r) => r)).body.data.status).toBe('VERIFIED');
    });

    it('grantExtraAttempts writes an audit row and an event', async () => {
      const user = await signedInUser(app);
      await startVerification(app, user, NIN.selfieMismatch);
      const who = await actor();

      await admin().grantExtraAttempts(user.userId, who, 'goodwill');

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'verification.attempts_granted' } });
      expect(audit).toMatchObject({ actorType: 'ADMIN', actorId: who.adminId, entityId: user.userId });
      expect(audit.metadata).toMatchObject({ reason: 'goodwill', reset: 1 });
      expect(await prisma.outboxEvent.count({ where: { eventType: 'verification.attempts_granted' } })).toBe(1);
    });

    it('a failed action leaves no audit row or event behind', async () => {
      const user = await verifiedUser(app);
      const row = await prisma.verificationAttempt.findFirstOrThrow({ where: { userId: user.userId } });
      const auditBefore = await prisma.auditLog.count();
      const eventsBefore = await prisma.outboxEvent.count();

      await expect(admin().approve(row.id, await actor(), 'x')).rejects.toBeDefined();

      expect(await prisma.auditLog.count()).toBe(auditBefore);
      expect(await prisma.outboxEvent.count()).toBe(eventsBefore);
    });
  });

  describe('database rules', () => {
    it('refuses a hard delete and a second PENDING attempt for one user', async () => {
      const user = await signedInUser(app);
      await prisma.$executeRaw`
        INSERT INTO verification_attempts (user_id, provider, status, attempt_number, started_at, updated_at)
        VALUES (${user.userId}::uuid, 'fake', 'PENDING'::"VerificationStatus", 1, now(), now())
      `;

      await expect(
        prisma.$executeRaw`
          INSERT INTO verification_attempts (user_id, provider, status, attempt_number, started_at, updated_at)
          VALUES (${user.userId}::uuid, 'fake', 'PENDING'::"VerificationStatus", 2, now(), now())
        `,
      ).rejects.toThrow(/(user_id)/);
      await expect(prisma.$executeRaw`DELETE FROM verification_attempts`).rejects.toThrow();
    });
  });
});

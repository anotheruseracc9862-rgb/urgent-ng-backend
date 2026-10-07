import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma, getTestRedis } from '../test/database.helper.js';
import {
  API,
  REQUIRED_CONSENTS,
  fakeOtp,
  lastCode,
  loginMobile,
  nextPhone,
  registerUser,
  seedPolicies,
  verifyUser,
} from '../test/auth.helper.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { BlocklistService } from './blocklist.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Registration, OTP and password reset (HTTP)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  const post = (path: string) => request(app.getHttpServer()).post(`${API}${path}`);

  const registerBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Ada Obi',
    phone: nextPhone(),
    password: 'Str0ng-passw0rd!',
    consents: REQUIRED_CONSENTS,
    ...overrides,
  });

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    fakeOtp(app).reset();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('registration', () => {
    it('registers with a phone: user, profile and consent records, nothing sensitive returned', async () => {
      const body = registerBody();

      const res = await post('/auth/register').send(body).expect(201);

      expect(res.body.data).toEqual({ userId: expect.any(String), verifyVia: 'phone', otpSent: true });
      expect(JSON.stringify(res.body)).not.toContain(body.password);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: res.body.data.userId } });
      expect(user.phoneE164).toBe(body.phone);
      expect(user.phoneVerifiedAt).toBeNull();
      expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(await prisma.profile.count({ where: { userId: user.id } })).toBe(1);
      const consents = await prisma.consentRecord.findMany({ where: { userId: user.id } });
      expect(consents.map((c) => c.consentType).sort()).toEqual(
        REQUIRED_CONSENTS.map((c) => c.type).sort(),
      );
      expect(consents.every((c) => c.documentVersion === '1.0')).toBe(true);
    });

    it('registers with an email, stored lower-cased', async () => {
      const res = await post('/auth/register')
        .send(registerBody({ phone: undefined, email: '  Ada.Obi@Example.COM ' }))
        .expect(201);

      expect(res.body.data.verifyVia).toBe('email');
      const user = await prisma.user.findUniqueOrThrow({ where: { id: res.body.data.userId } });
      expect(user.email).toBe('ada.obi@example.com');
      expect(fakeOtp(app).getCalls('sendEmail')).toHaveLength(1);
    });

    it('normalises common Nigerian phone formats to +234', async () => {
      const res = await post('/auth/register').send(registerBody({ phone: '0803 123 4567' })).expect(201);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: res.body.data.userId } });
      expect(user.phoneE164).toBe('+2348031234567');
    });

    it('needs a phone or an email', async () => {
      const res = await post('/auth/register').send(registerBody({ phone: undefined })).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an invalid phone, a short password and unknown fields', async () => {
      await post('/auth/register').send(registerBody({ phone: '12345' })).expect(400);
      await post('/auth/register').send(registerBody({ password: 'short' })).expect(400);
      await post('/auth/register').send(registerBody({ isAdmin: true })).expect(400);
    });

    it('rejects a registration that misses a required consent and says which', async () => {
      const res = await post('/auth/register')
        .send(registerBody({ consents: REQUIRED_CONSENTS.slice(0, 2) }))
        .expect(400);

      expect(res.body.error.details.missingConsents).toEqual(['SAFETY_POLICY', 'PROHIBITED_ITEMS_POLICY', 'OFFLINE_PAYMENT_TERMS']);
    });

    it('rejects a policy version that does not exist', async () => {
      const consents = [...REQUIRED_CONSENTS.slice(1), { type: 'TERMS_OF_SERVICE', version: '9.9' }];

      const res = await post('/auth/register').send(registerBody({ consents })).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a policy version that is not published yet', async () => {
      await prisma.$executeRaw`
        INSERT INTO policy_versions (type, version, document_ref, published_at)
        VALUES ('TERMS_OF_SERVICE'::"ConsentType", '2.0', 'x', now() + interval '1 day')
      `;
      const consents = [...REQUIRED_CONSENTS.slice(1), { type: 'TERMS_OF_SERVICE', version: '2.0' }];

      await post('/auth/register').send(registerBody({ consents })).expect(400);
    });

    it('blocks a blocklisted phone and email', async () => {
      const blocklist = app.get(BlocklistService);
      await blocklist.blockPhone('+2348031111111', 'FRAUD');
      await blocklist.blockEmail('Bad@Example.com', 'FRAUD');

      const phone = await post('/auth/register').send(registerBody({ phone: '+2348031111111' })).expect(403);
      const email = await post('/auth/register')
        .send(registerBody({ phone: undefined, email: 'bad@example.com' }))
        .expect(403);

      expect(phone.body.error.code).toBe('REGISTRATION_BLOCKED');
      expect(email.body.error.code).toBe('REGISTRATION_BLOCKED');
      expect(await prisma.user.count()).toBe(0);
    });

    it('does not store the phone or email in the blocklist, only a keyed hash', async () => {
      await app.get(BlocklistService).blockPhone('+2348031111111', 'FRAUD');

      const [entry] = await prisma.blocklistEntry.findMany();
      expect(JSON.stringify(entry)).not.toContain('8031111111');
      expect(entry.valueHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('refuses a phone that a verified account already holds', async () => {
      const first = await registerUser(app);
      await verifyUser(app, first);

      const res = await post('/auth/register').send(registerBody({ phone: first.phone })).expect(409);

      expect(res.body.error.code).toBe('IDENTIFIER_TAKEN');
    });

    it('refuses a phone held by a recent unverified registration', async () => {
      const first = await registerUser(app);

      await post('/auth/register').send(registerBody({ phone: first.phone })).expect(409);
    });

    it('lets a new registration take over a stale unverified one (no squatting)', async () => {
      const squatter = await registerUser(app);
      await prisma.$executeRaw`UPDATE users SET created_at = now() - interval '1 hour' WHERE id = ${squatter.userId}::uuid`;

      const owner = await post('/auth/register').send(registerBody({ phone: squatter.phone })).expect(201);

      expect(owner.body.data.userId).not.toBe(squatter.userId);
      const old = await prisma.user.findUniqueOrThrow({ where: { id: squatter.userId } });
      expect(old.deletedAt).not.toBeNull();
      expect(old.status).toBe('DELETED');
    });

    it('creates exactly one account when the same phone registers in parallel', async () => {
      const phone = nextPhone();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => post('/auth/register').send(registerBody({ phone }))),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await prisma.user.count({ where: { phoneE164: phone } })).toBe(1);
    });

    it('is stopped by the registrations kill switch', async () => {
      await app.get(BusinessConfigService).set('FEATURE_REGISTRATIONS_ENABLED', false);

      const res = await post('/auth/register').send(registerBody()).expect(503);

      expect(res.body.error.code).toBe('FEATURE_DISABLED');
    });

    it('still creates the account when the code cannot be delivered, and reports it', async () => {
      fakeOtp(app).scriptOutcomes('sendSms', [{ success: false, error: 'provider down' }]);

      const res = await post('/auth/register').send(registerBody()).expect(201);

      expect(res.body.data.otpSent).toBe(false);
      expect(await prisma.user.count()).toBe(1);
    });
  });

  describe('OTP verification', () => {
    it('verifies the code, marks the phone verified, and the code works once only', async () => {
      const user = await registerUser(app);
      const code = lastCode(app, user.phone);

      await post('/auth/otp/verify').send({ phone: user.phone, code }).expect(200);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(row.phoneVerifiedAt).not.toBeNull();
      const again = await post('/auth/otp/verify').send({ phone: user.phone, code }).expect(400);
      expect(again.body.error.code).toBe('OTP_EXPIRED');
    });

    it('verifies an email the same way', async () => {
      const user = await registerUser(app, { email: 'ada@example.com' });

      await post('/auth/otp/verify').send({ email: 'ADA@example.com', code: lastCode(app, user.phone) }).expect(200);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(row.emailVerifiedAt).not.toBeNull();
    });

    it('tells the user how many attempts are left, then locks the code after 5 wrong ones', async () => {
      const user = await registerUser(app);
      const code = lastCode(app, user.phone);
      const wrong = code === '000000' ? '111111' : '000000';

      for (let left = 4; left >= 0; left--) {
        const res = await post('/auth/otp/verify').send({ phone: user.phone, code: wrong }).expect(400);
        expect(res.body.error.code).toBe('OTP_INVALID');
        expect(res.body.error.details.remainingAttempts).toBe(left);
      }

      const sixth = await post('/auth/otp/verify').send({ phone: user.phone, code: wrong }).expect(429);
      expect(sixth.body.error.code).toBe('OTP_RATE_LIMITED');
      // even the right code is refused now
      await post('/auth/otp/verify').send({ phone: user.phone, code }).expect(429);
    });

    it('cannot be brute-forced with parallel guesses', async () => {
      const user = await registerUser(app);
      const code = lastCode(app, user.phone);
      const guesses = Array.from({ length: 30 }, (_, i) => String(i).padStart(6, '0')).filter((g) => g !== code);

      const results = await Promise.all(
        guesses.map((guess) => post('/auth/otp/verify').send({ phone: user.phone, code: guess })),
      );

      expect(results.filter((r) => r.status === 400)).toHaveLength(5);
      expect(results.filter((r) => r.status === 429)).toHaveLength(guesses.length - 5);
      await post('/auth/otp/verify').send({ phone: user.phone, code }).expect(429);
    });

    it('expires after the TTL', async () => {
      const user = await registerUser(app);
      const redis = getTestRedis();
      const [key] = await redis.keys('otp:code:*');
      await redis.pexpire(key, 300);
      await new Promise((resolve) => setTimeout(resolve, 450));

      const res = await post('/auth/otp/verify').send({ phone: user.phone, code: lastCode(app, user.phone) }).expect(400);

      expect(res.body.error.code).toBe('OTP_EXPIRED');
    });

    it('stores only a hash, never the code', async () => {
      const user = await registerUser(app);
      const code = lastCode(app, user.phone);
      const redis = getTestRedis();

      const [key] = await redis.keys('otp:code:*');
      const stored = await redis.hgetall(key);

      expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(code);
      expect(key).not.toContain(user.phone.slice(1));
      expect(await redis.ttl(key)).toBeGreaterThan(590);
    });

    it('never returns the code in any response', async () => {
      const body = registerBody();
      const reg = await post('/auth/register').send(body).expect(201);
      const code = lastCode(app, body.phone as string);
      const resend = await post('/auth/otp/resend').send({ phone: body.phone });

      expect(JSON.stringify(reg.body)).not.toContain(code);
      expect(JSON.stringify(resend.body)).not.toContain(code);
    });

    it('a registration code cannot be used to reset a password', async () => {
      const user = await registerUser(app);
      const code = lastCode(app, user.phone);

      const res = await post('/auth/password/reset')
        .send({ phone: user.phone, code, newPassword: 'Another-passw0rd!' })
        .expect(400);

      expect(res.body.error.code).toBe('OTP_EXPIRED');
    });

    it('a code sent to one phone is useless for another', async () => {
      const a = await registerUser(app);
      const b = await registerUser(app);

      await post('/auth/otp/verify').send({ phone: b.phone, code: lastCode(app, a.phone) }).expect(400);
    });

    it('audits issue, failure and verification without the code or the full number', async () => {
      const user = await registerUser(app);
      const code = lastCode(app, user.phone);
      await post('/auth/otp/verify').send({ phone: user.phone, code: code === '123456' ? '654321' : '123456' }).expect(400);
      await post('/auth/otp/verify').send({ phone: user.phone, code }).expect(200);

      const logs = await prisma.auditLog.findMany({ where: { action: { startsWith: 'auth.otp' } } });

      expect(logs.map((l) => l.action).sort()).toEqual(['auth.otp.failed', 'auth.otp.issued', 'auth.otp.verified']);
      expect(JSON.stringify(logs)).not.toContain(code);
      expect(JSON.stringify(logs)).not.toContain(user.phone);
    });
  });

  describe('OTP sending limits', () => {
    it('enforces the 60 second resend cooldown', async () => {
      const user = await registerUser(app);

      const res = await post('/auth/otp/resend').send({ phone: user.phone }).expect(429);

      expect(res.body.error.code).toBe('OTP_RATE_LIMITED');
      expect(res.body.error.details.reason).toBe('cooldown');
      expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(50);
    });

    it('allows 5 codes per destination per hour', async () => {
      const user = await registerUser(app); // 1st code
      const redis = getTestRedis();

      for (let i = 2; i <= 5; i++) {
        await redis.del(...(await redis.keys('otp:cooldown:*')));
        await post('/auth/otp/resend').send({ phone: user.phone }).expect(200);
      }
      await redis.del(...(await redis.keys('otp:cooldown:*')));

      const res = await post('/auth/otp/resend').send({ phone: user.phone }).expect(429);
      expect(res.body.error.details.reason).toBe('destination_limit');
    });

    it('allows 10 codes per IP per hour', async () => {
      for (let i = 0; i < 10; i++) {
        await post('/auth/otp/resend').send({ phone: nextPhone() }).expect(200);
      }

      const res = await post('/auth/otp/resend').send({ phone: nextPhone() }).expect(429);
      expect(res.body.error.details.reason).toBe('ip_limit');
    });

    it('counts parallel requests exactly (no extra codes slip through)', async () => {
      const user = await registerUser(app);
      const redis = getTestRedis();
      await redis.del(...(await redis.keys('otp:cooldown:*')));

      const results = await Promise.all(
        Array.from({ length: 6 }, () => post('/auth/otp/resend').send({ phone: user.phone })),
      );

      // the cooldown lets exactly one of the parallel requests through
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    });

    it('answers the same for a phone with no account, and sends nothing to it', async () => {
      const unknown = nextPhone();

      const res = await post('/auth/otp/resend').send({ phone: unknown }).expect(200);

      expect(res.body.data).toEqual({ sent: true });
      expect(fakeOtp(app).getCalls('sendSms')).toHaveLength(0);
    });

    it('applies the same cooldown to a phone with no account (no probing)', async () => {
      const unknown = nextPhone();
      await post('/auth/otp/resend').send({ phone: unknown }).expect(200);

      const res = await post('/auth/otp/resend').send({ phone: unknown }).expect(429);

      expect(res.body.error.details.reason).toBe('cooldown');
    });

    it('lets the user retry at once when delivery failed', async () => {
      const user = await registerUser(app);
      await getTestRedis().del(...(await getTestRedis().keys('otp:cooldown:*')));
      fakeOtp(app).scriptOutcomes('sendSms', [{ success: false, error: 'provider down' }]);

      const failed = await post('/auth/otp/resend').send({ phone: user.phone }).expect(502);
      expect(failed.body.error.code).toBe('OTP_DELIVERY_FAILED');

      await post('/auth/otp/resend').send({ phone: user.phone }).expect(200);
    });

    it('reads its limits from admin config', async () => {
      await app.get(BusinessConfigService).set('OTP_MAX_ATTEMPTS', 2);
      const user = await registerUser(app);
      const wrong = lastCode(app, user.phone) === '000000' ? '111111' : '000000';

      await post('/auth/otp/verify').send({ phone: user.phone, code: wrong }).expect(400);
      await post('/auth/otp/verify').send({ phone: user.phone, code: wrong }).expect(400);
      await post('/auth/otp/verify').send({ phone: user.phone, code: wrong }).expect(429);
    });
  });

  describe('password reset', () => {
    it('resets the password with the code, ends every session and clears the lockout', async () => {
      const user = await registerUser(app);
      await verifyUser(app, user);
      const tokens = await loginMobile(app, user);
      await prisma.$executeRaw`UPDATE users SET failed_login_count = 9, locked_until = now() + interval '10 minutes' WHERE id = ${user.userId}::uuid`;

      await post('/auth/password/forgot').send({ phone: user.phone }).expect(200);
      await post('/auth/password/reset')
        .send({ phone: user.phone, code: lastCode(app, user.phone), newPassword: 'Brand-new-passw0rd' })
        .expect(200);

      await post('/auth/login').send({ phone: user.phone, password: user.password }).expect(401);
      await post('/auth/login')
        .set('X-Client', 'mobile')
        .send({ phone: user.phone, password: 'Brand-new-passw0rd' })
        .expect(200);
      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: tokens.refreshToken }).expect(401);
    });

    it('answers the same for an unknown phone and sends nothing', async () => {
      const res = await post('/auth/password/forgot').send({ phone: nextPhone() }).expect(200);

      expect(res.body.data).toEqual({ sent: true });
      expect(fakeOtp(app).getCalls('sendSms')).toHaveLength(0);
    });

    it('rejects a wrong code and does not change the password', async () => {
      const user = await registerUser(app);
      await post('/auth/password/forgot').send({ phone: user.phone }).expect(200);
      const code = lastCode(app, user.phone);

      await post('/auth/password/reset')
        .send({ phone: user.phone, code: code === '000000' ? '111111' : '000000', newPassword: 'Brand-new-passw0rd' })
        .expect(400);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(await import('argon2').then((a) => a.verify(row.passwordHash, user.password))).toBe(true);
    });

    it('does not reveal whether an account exists when the code is wrong', async () => {
      const res = await post('/auth/password/reset')
        .send({ phone: nextPhone(), code: '123456', newPassword: 'Brand-new-passw0rd' })
        .expect(400);

      expect(res.body.error.code).toBe('OTP_EXPIRED');
    });

    it('works with an email', async () => {
      const user = await registerUser(app, { email: 'ada@example.com' });

      await post('/auth/password/forgot').send({ email: 'Ada@Example.com' }).expect(200);
      await post('/auth/password/reset')
        .send({ email: 'ada@example.com', code: lastCode(app, 'ada@example.com'), newPassword: 'Brand-new-passw0rd' })
        .expect(200);

      await post('/auth/login').set('X-Client', 'mobile').send({ email: 'ada@example.com', password: 'Brand-new-passw0rd' }).expect(200);
      expect(user.userId).toBeDefined();
    });
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, enforcementActionFor, getTestPrisma } from '../test/database.helper.js';
import {
  API,
  bearer,
  fakeOtp,
  loginMobile,
  nextPhone,
  registerUser,
  seedPolicies,
  signedInUser,
  verifyUser,
  type TestUser,
} from '../test/auth.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Login, sessions and tokens (HTTP)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  const post = (path: string) => request(app.getHttpServer()).post(`${API}${path}`);
  const get = (path: string) => request(app.getHttpServer()).get(`${API}${path}`);
  const del = (path: string) => request(app.getHttpServer()).delete(`${API}${path}`);

  const login = (user: TestUser, password = user.password) =>
    post('/auth/login').set('X-Client', 'mobile').send({ phone: user.phone, password });

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

  describe('login', () => {
    it('mobile clients get both tokens in the body', async () => {
      const user = await registerUser(app);

      const res = await login(user).expect(200);

      expect(res.body.data).toMatchObject({
        userId: user.userId,
        status: 'ACTIVE',
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        expiresIn: 900,
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('web clients get HTTP-only cookies and no tokens in the body', async () => {
      const user = await registerUser(app);

      const res = await post('/auth/login').send({ phone: user.phone, password: user.password }).expect(200);

      expect(res.body.data).toEqual({ userId: user.userId, status: 'ACTIVE', expiresIn: 900 });
      const cookies = res.headers['set-cookie'] as unknown as string[];
      const access = cookies.find((c) => c.startsWith('ung_at='))!;
      const refresh = cookies.find((c) => c.startsWith('ung_rt='))!;
      expect(access).toMatch(/HttpOnly/i);
      expect(access).toMatch(/SameSite=Strict/i);
      expect(access).toMatch(/Path=\/;/);
      expect(refresh).toMatch(/HttpOnly/i);
      expect(refresh).toMatch(/SameSite=Strict/i);
      expect(refresh).toContain('Path=/api/v1/auth');
    });

    it('the cookie authenticates later requests', async () => {
      const user = await registerUser(app);
      const agent = request.agent(app.getHttpServer());
      await agent.post(`${API}/auth/login`).send({ phone: user.phone, password: user.password }).expect(200);

      const me = await agent.get(`${API}/me`).expect(200);

      expect(me.body.data.id).toBe(user.userId);
    });

    it('logs in with a phone in another format, or an email in any case', async () => {
      const phoneUser = await registerUser(app, { phone: '+2348031234567' });
      const emailUser = await registerUser(app, { email: 'ada@example.com' });

      await post('/auth/login').set('X-Client', 'mobile').send({ phone: '0803 123 4567', password: phoneUser.password }).expect(200);
      await post('/auth/login').set('X-Client', 'mobile').send({ email: ' ADA@Example.com ', password: emailUser.password }).expect(200);
    });

    it('wrong password and unknown account give the identical answer', async () => {
      const user = await registerUser(app);

      const wrong = await login(user, 'Wrong-passw0rd!').expect(401);
      const unknown = await login({ ...user, phone: nextPhone() }).expect(401);

      expect(wrong.body.error).toEqual(unknown.body.error);
      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('needs exactly one identifier', async () => {
      await post('/auth/login').send({ password: 'x' }).expect(400);
      await post('/auth/login').send({ phone: nextPhone(), email: 'a@b.co', password: 'x' }).expect(400);
    });

    it('lets an unverified user log in (verification is needed to post, not to sign in)', async () => {
      const user = await registerUser(app);

      await login(user).expect(200);
    });

    it('does not let a deleted account log in', async () => {
      const user = await registerUser(app);
      await prisma.$executeRaw`UPDATE users SET status = 'DELETED'::"UserStatus", deleted_at = now() WHERE id = ${user.userId}::uuid`;

      await login(user).expect(401);
    });

    it('lets deactivated and deletion-pending users log in (they need a session to come back)', async () => {
      const a = await registerUser(app);
      const b = await registerUser(app);
      await prisma.$executeRaw`UPDATE users SET status = 'DEACTIVATED'::"UserStatus" WHERE id = ${a.userId}::uuid`;
      await prisma.$executeRaw`UPDATE users SET status = 'DELETION_PENDING'::"UserStatus" WHERE id = ${b.userId}::uuid`;

      expect((await login(a).expect(200)).body.data.status).toBe('DEACTIVATED');
      expect((await login(b).expect(200)).body.data.status).toBe('DELETION_PENDING');
    });

    it('an active ACCOUNT_LOGIN restriction blocks login; an ended one does not', async () => {
      const user = await registerUser(app);
      const enforcement = await enforcementActionFor(user.userId);
      await prisma.$executeRaw`
        INSERT INTO user_restrictions (user_id, type, status, starts_at, ends_at, enforcement_action_id, updated_at)
        VALUES (${user.userId}::uuid, 'ACCOUNT_LOGIN'::"UserRestrictionType", 'ACTIVE'::"RestrictionStatus",
                now() - interval '1 hour', now() + interval '1 hour', ${enforcement}::uuid, now())
      `;

      const blocked = await login(user).expect(403);
      expect(blocked.body.error.code).toBe('ACCOUNT_SUSPENDED');

      await prisma.$executeRaw`UPDATE user_restrictions SET ends_at = now() - interval '1 minute'`;
      await login(user).expect(200);
    });

    it('never returns the password hash anywhere', async () => {
      const { accessToken } = await signedInUser(app);

      const me = await get('/me').set(...bearer(accessToken)).expect(200);

      expect(JSON.stringify(me.body)).not.toMatch(/argon2|passwordHash|password_hash/);
    });

    it('audits success and failure without the password', async () => {
      const user = await registerUser(app);
      await login(user, 'Wrong-passw0rd!').expect(401);
      await login(user).expect(200);

      const logs = await prisma.auditLog.findMany({ where: { action: { startsWith: 'auth.login' } } });

      expect(logs.map((l) => l.action).sort()).toEqual(['auth.login', 'auth.login.failed']);
      expect(JSON.stringify(logs)).not.toContain(user.password);
      expect(JSON.stringify(logs)).not.toContain('Wrong-passw0rd');
    });
  });

  describe('lockout', () => {
    it('locks after 10 failures and says when to retry, even for the right password', async () => {
      const user = await registerUser(app);
      for (let i = 0; i < 10; i++) {
        await login(user, 'Wrong-passw0rd!').expect(401);
      }

      const locked = await login(user).expect(429);

      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
      expect(locked.body.error.details.retryAfterSeconds).toBeGreaterThan(800);
      expect(locked.body.error.details.retryAfterSeconds).toBeLessThanOrEqual(900);
    });

    it('works again once the lock has expired, and resets the counter', async () => {
      const user = await registerUser(app);
      for (let i = 0; i < 10; i++) await login(user, 'Wrong-passw0rd!');
      await prisma.$executeRaw`UPDATE users SET locked_until = now() - interval '1 second'`;

      await login(user).expect(200);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(row.failedLoginCount).toBe(0);
      expect(row.lockedUntil).toBeNull();
      expect(row.firstFailedLoginAt).toBeNull();
    });

    it('counts failures inside a window only: old failures do not add up', async () => {
      const user = await registerUser(app);
      await prisma.$executeRaw`
        UPDATE users SET failed_login_count = 9, first_failed_login_at = now() - interval '20 minutes'
        WHERE id = ${user.userId}::uuid
      `;

      await login(user, 'Wrong-passw0rd!').expect(401);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(row.failedLoginCount).toBe(1);
      expect(row.lockedUntil).toBeNull();
    });

    it('parallel guesses cannot get past the limit', async () => {
      const user = await registerUser(app);

      // 30 guesses at once. How many are already being checked when the lock lands depends on how
      // fast hashing is, so the test does not count them: it checks that the failures are all counted
      // atomically, the lock is set, and that from then on no guess is evaluated any more.
      const burst = await Promise.all(Array.from({ length: 30 }, () => login(user, 'Wrong-passw0rd!')));
      expect(burst.every((r) => r.status === 401 || r.status === 429)).toBe(true);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(row.lockedUntil).not.toBeNull();
      expect(row.failedLoginCount).toBeGreaterThanOrEqual(10);

      const after = await Promise.all(Array.from({ length: 30 }, () => login(user, 'Wrong-passw0rd!')));
      expect(after.every((r) => r.status === 429)).toBe(true);
      await login(user).expect(429); // even the right password is refused while locked
      const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(unchanged.failedLoginCount).toBe(row.failedLoginCount); // refused attempts are not evaluated or counted
    });

    it('reads the limit from admin config', async () => {
      const { BusinessConfigService } = await import('../config/business-config.service.js');
      await app.get(BusinessConfigService).set('LOGIN_LOCKOUT_FAILURES', 3);
      const user = await registerUser(app);

      for (let i = 0; i < 3; i++) await login(user, 'Wrong-passw0rd!').expect(401);

      await login(user).expect(429);
    });

    it('records the lockout in the audit trail', async () => {
      const user = await registerUser(app);
      for (let i = 0; i < 10; i++) await login(user, 'Wrong-passw0rd!');

      expect(await prisma.auditLog.count({ where: { action: 'auth.login.locked_out' } })).toBe(1);
    });
  });

  describe('refresh and rotation', () => {
    it('gives a new pair and retires the old refresh token', async () => {
      const user = await registerUser(app);
      const first = await loginMobile(app, user);

      const res = await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: first.refreshToken }).expect(200);

      expect(res.body.data.refreshToken).not.toBe(first.refreshToken);
      await get('/me').set(...bearer(res.body.data.accessToken)).expect(200);
      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: first.refreshToken }).expect(401);
    });

    it('stores only a hash of the refresh token', async () => {
      const user = await registerUser(app);
      const tokens = await loginMobile(app, user);

      const rows = await prisma.authSession.findMany();

      expect(JSON.stringify(rows)).not.toContain(tokens.refreshToken);
    });

    it('replaying a rotated token revokes the whole login (reuse detection)', async () => {
      const user = await registerUser(app);
      const first = await loginMobile(app, user);
      const second = await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: first.refreshToken }).expect(200);
      // the rotation happened a while ago, so this is a replay, not a double click
      await prisma.$executeRaw`UPDATE auth_sessions SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL`;

      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: first.refreshToken }).expect(401);

      // the thief's replay also killed the legitimate newest token
      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: second.body.data.refreshToken }).expect(401);
      expect(await prisma.auditLog.count({ where: { action: 'auth.refresh.reuse_detected' } })).toBe(1);
    });

    it('a second use right after a rotation (double click, second tab) is refused but does not log the user out', async () => {
      const user = await registerUser(app);
      const first = await loginMobile(app, user);
      const second = await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: first.refreshToken }).expect(200);

      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: first.refreshToken }).expect(401);

      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: second.body.data.refreshToken }).expect(200);
    });

    it('of two parallel refreshes with the same token only one succeeds', async () => {
      const user = await registerUser(app);
      const first = await loginMobile(app, user);

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: first.refreshToken }),
        ),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 401)).toHaveLength(4);
    });

    it('rejects expired, unknown, malformed and missing refresh tokens with 401', async () => {
      const user = await registerUser(app);
      const tokens = await loginMobile(app, user);
      await prisma.$executeRaw`UPDATE auth_sessions SET expires_at = now() - interval '1 second'`;

      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: tokens.refreshToken }).expect(401);
      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: 'nonsense' }).expect(401);
      await post('/auth/refresh').set('X-Client', 'mobile').send({}).expect(401);
      await post('/auth/refresh').send({}).expect(401);
    });

    it('web: refreshes from the cookie and sets new cookies', async () => {
      const user = await registerUser(app);
      const agent = request.agent(app.getHttpServer());
      await agent.post(`${API}/auth/login`).send({ phone: user.phone, password: user.password }).expect(200);

      const res = await agent.post(`${API}/auth/refresh`).send({}).expect(200);

      expect(res.headers['set-cookie']).toBeDefined();
      await agent.get(`${API}/me`).expect(200);
    });

    it('does not refresh for a user whose account was deleted, and ends that login', async () => {
      const user = await registerUser(app);
      const tokens = await loginMobile(app, user);
      await prisma.$executeRaw`UPDATE users SET status = 'DELETED'::"UserStatus", deleted_at = now()`;

      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: tokens.refreshToken }).expect(401);

      expect(await prisma.authSession.count({ where: { revokedAt: null } })).toBe(0);
    });

    it('uses the configured lifetimes', async () => {
      const { BusinessConfigService } = await import('../config/business-config.service.js');
      const config = app.get(BusinessConfigService);
      await config.set('ACCESS_TOKEN_MINUTES', 5);
      await config.set('REFRESH_TOKEN_DAYS', 7);
      const user = await registerUser(app);

      const res = await login(user).expect(200);

      expect(res.body.data.expiresIn).toBe(300);
      const [session] = await prisma.$queryRaw<Array<{ days: number }>>`
        SELECT round(extract(epoch FROM (expires_at - now())) / 86400)::int AS days FROM auth_sessions
      `;
      expect(session.days).toBe(7);
    });
  });

  describe('logout and session management', () => {
    it('logout ends the login: its refresh token stops working', async () => {
      const user = await registerUser(app);
      const tokens = await loginMobile(app, user);

      await post('/auth/logout').set('X-Client', 'mobile').send({ refreshToken: tokens.refreshToken }).expect(200);

      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: tokens.refreshToken }).expect(401);
    });

    it('logout never fails and clears the cookies, even with no or a bad token', async () => {
      const res = await post('/auth/logout').send({ refreshToken: 'junk' }).expect(200);

      const cookies = (res.headers['set-cookie'] as unknown as string[]).join(';');
      expect(cookies).toContain('ung_at=;');
      expect(cookies).toContain('ung_rt=;');
    });

    it('lists my sessions, marking the current one', async () => {
      const user = await registerUser(app);
      const phone = await loginMobile(app, user);
      await loginMobile(app, user); // a second device

      const res = await get('/me/sessions').set(...bearer(phone.accessToken)).expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      expect(res.body.data[0]).toEqual(
        expect.objectContaining({ id: expect.any(String), startedAt: expect.any(String), expiresAt: expect.any(String) }),
      );
    });

    it('never lists another user’s sessions', async () => {
      const a = await signedInUser(app);
      await signedInUser(app);

      const res = await get('/me/sessions').set(...bearer(a.accessToken)).expect(200);

      expect(res.body.data).toHaveLength(1);
    });

    it('revokes one of my sessions', async () => {
      const user = await registerUser(app);
      const phone = await loginMobile(app, user);
      const laptop = await loginMobile(app, user);
      const sessions = await get('/me/sessions').set(...bearer(phone.accessToken));
      const other = sessions.body.data.find((s: { current: boolean }) => !s.current);

      await del(`/me/sessions/${other.id}`).set(...bearer(phone.accessToken)).expect(204);

      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: laptop.refreshToken }).expect(401);
      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: phone.refreshToken }).expect(200);
    });

    it('cannot revoke another user’s session (and cannot tell it exists)', async () => {
      const a = await signedInUser(app);
      const b = await signedInUser(app);
      const [bSession] = (await get('/me/sessions').set(...bearer(b.accessToken))).body.data;

      const res = await del(`/me/sessions/${bSession.id}`).set(...bearer(a.accessToken)).expect(404);

      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
      await post('/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: b.refreshToken }).expect(200);
    });

    it('rejects a session id that is not a UUID', async () => {
      const { accessToken } = await signedInUser(app);

      await del('/me/sessions/not-a-uuid').set(...bearer(accessToken)).expect(400);
    });
  });

  describe('access tokens', () => {
    it('rejects missing, garbage, expired, wrong-audience and tampered tokens', async () => {
      const { accessToken, userId } = await signedInUser(app);
      const jwt = app.get(JwtService);
      const secret = process.env.JWT_SECRET || 'development-only-jwt-secret-not-for-production';
      const expired = await jwt.signAsync({ sub: userId, sid: 'x', type: 'access' }, { secret, audience: 'urgent-consumer', expiresIn: -10 });
      const wrongAudience = await jwt.signAsync({ sub: userId, sid: 'x', type: 'access' }, { secret, audience: 'urgent-admin', expiresIn: 60 });
      const noType = await jwt.signAsync({ sub: userId }, { secret, audience: 'urgent-consumer', expiresIn: 60 });
      const wrongSecret = await jwt.signAsync({ sub: userId, sid: 'x', type: 'access' }, { secret: 'a-completely-different-secret-value', audience: 'urgent-consumer', expiresIn: 60 });

      await get('/me').expect(401);
      await get('/me').set(...bearer('garbage')).expect(401);
      await get('/me').set(...bearer(expired)).expect(401);
      await get('/me').set(...bearer(wrongAudience)).expect(401);
      await get('/me').set(...bearer(noType)).expect(401);
      await get('/me').set(...bearer(wrongSecret)).expect(401);
      await get('/me').set(...bearer(accessToken.slice(0, -3) + 'abc')).expect(401);
      const none = await get('/me').expect(401);
      expect(none.body.error.code).toBe('AUTH_REQUIRED');
    });

    it('stops working at once when the account is deleted', async () => {
      const { accessToken, userId } = await signedInUser(app);
      await prisma.$executeRaw`UPDATE users SET status = 'DELETED'::"UserStatus", deleted_at = now() WHERE id = ${userId}::uuid`;

      await get('/me').set(...bearer(accessToken)).expect(401);
    });

    it('the unverified user can read their own profile', async () => {
      const user = await registerUser(app);
      const tokens = await loginMobile(app, user);

      const me = await get('/me').set(...bearer(tokens.accessToken)).expect(200);

      expect(me.body.data.phoneVerified).toBe(false);
      await verifyUser(app, user);
      expect((await get('/me').set(...bearer(tokens.accessToken)).expect(200)).body.data.phoneVerified).toBe(true);
    });
  });
});

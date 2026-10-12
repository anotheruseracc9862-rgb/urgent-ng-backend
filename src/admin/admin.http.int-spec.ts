import { ADMIN_PERMISSIONS } from './admin.permissions.js';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp } from '../app.setup.js';
import { AdminModule } from './admin.module.js';
import { AdminAuth } from './decorators/admin-auth.decorator.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import {
  API,
  adminLogin,
  bearer,
  createAdmin,
  nextTotpCode,
  seedAdminRoles,
  seedPolicies,
  signedInUser,
} from '../test/auth.helper.js';
import { totpCode, totpStep } from '../common/utils/totp.js';

process.env.RATE_LIMIT_DISABLED = 'true';

@Controller('admin/t')
class AdminProbeController {
  @Get('open')
  @AdminAuth()
  open() {
    return { ok: true };
  }

  @Get('users')
  @AdminAuth('USERS_VIEW')
  users() {
    return { ok: true };
  }

  @Get('both')
  @AdminAuth('USERS_VIEW', 'BILLING_VIEW')
  both() {
    return { ok: true };
  }
}

describe('Admin identity and access (HTTP)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  const server = () => app.getHttpServer();
  const post = (path: string) => request(server()).post(`${API}${path}`);
  const get = (path: string, token?: string) => {
    const req = request(server()).get(`${API}${path}`);
    return token ? req.set(...bearer(token)) : req;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, AdminModule],
      controllers: [AdminProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    await seedAdminRoles();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('login with mandatory MFA', () => {
    it('password alone never gives a session: it asks for MFA enrolment on the first login', async () => {
      const admin = await createAdmin(app);

      const res = await post('/admin/auth/login').send({ email: admin.email, password: admin.password }).expect(200);

      expect(res.body.data).toEqual({ status: 'MFA_ENROLMENT_REQUIRED', mfaToken: expect.any(String) });
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await prisma.adminSession.count()).toBe(0);
    });

    it('enrolment returns the secret and an otpauth link; the secret is stored encrypted', async () => {
      const admin = await createAdmin(app);
      const { mfaToken } = (await post('/admin/auth/login').send({ email: admin.email, password: admin.password })).body.data;

      const res = await post('/admin/auth/mfa/enrol').send({ mfaToken }).expect(200);

      expect(res.body.data.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(res.body.data.otpauthUri).toContain('otpauth://totp/');
      const row = await prisma.admin.findUniqueOrThrow({ where: { id: admin.adminId } });
      expect(row.mfaSecretEncrypted).not.toBeNull();
      expect(row.mfaSecretEncrypted).not.toContain(res.body.data.secret);
      expect(row.mfaEnabled).toBe(false);
    });

    it('a correct code completes the login, enables MFA and sets the admin cookies', async () => {
      const admin = await createAdmin(app);
      const { mfaToken } = (await post('/admin/auth/login').send({ email: admin.email, password: admin.password })).body.data;
      const { secret } = (await post('/admin/auth/mfa/enrol').send({ mfaToken })).body.data;

      const res = await post('/admin/auth/mfa/verify').send({ mfaToken, code: await nextTotpCode(secret) }).expect(200);

      expect(res.body.data.admin).toMatchObject({ email: admin.email, roles: ['SUPER_ADMIN'] });
      const cookies = (res.headers['set-cookie'] as unknown as string[]).join('\n');
      expect(cookies).toMatch(/ung_admin_at=.*HttpOnly/is);
      expect(cookies).toMatch(/ung_admin_rt=.*Path=\/api\/v1\/admin\/auth/is);
      expect(cookies).not.toContain('ung_at=');
      const row = await prisma.admin.findUniqueOrThrow({ where: { id: admin.adminId } });
      expect(row.mfaEnabled).toBe(true);
      expect(row.lastLoginAt).not.toBeNull();
    });

    it('later logins ask for a code, and enrolment is closed', async () => {
      const admin = await adminLogin(app, await createAdmin(app));

      const again = await post('/admin/auth/login').send({ email: admin.email, password: admin.password }).expect(200);
      expect(again.body.data.status).toBe('MFA_REQUIRED');
      const enrol = await post('/admin/auth/mfa/enrol').send({ mfaToken: again.body.data.mfaToken }).expect(409);
      expect(enrol.body.error.code).toBe('RESOURCE_CONFLICT');
    });

    it('rejects a wrong code and keeps MFA off until a right one', async () => {
      const admin = await createAdmin(app);
      const { mfaToken } = (await post('/admin/auth/login').send({ email: admin.email, password: admin.password })).body.data;
      const { secret } = (await post('/admin/auth/mfa/enrol').send({ mfaToken })).body.data;
      const right = totpCode(secret, totpStep());
      const wrong = right === '000000' ? '111111' : '000000';

      const res = await post('/admin/auth/mfa/verify').send({ mfaToken, code: wrong }).expect(401);

      expect(res.body.error.code).toBe('MFA_INVALID');
      expect((await prisma.admin.findUniqueOrThrow({ where: { id: admin.adminId } })).mfaEnabled).toBe(false);
      expect(await prisma.adminSession.count()).toBe(0);
    });

    it('a code works once only (replay protection)', async () => {
      const admin = await createAdmin(app);
      const { mfaToken } = (await post('/admin/auth/login').send({ email: admin.email, password: admin.password })).body.data;
      const { secret } = (await post('/admin/auth/mfa/enrol').send({ mfaToken })).body.data;
      const code = totpCode(secret, totpStep());

      await post('/admin/auth/mfa/verify').send({ mfaToken, code }).expect(200);
      const again = await post('/admin/auth/mfa/verify').send({ mfaToken, code }).expect(401);

      expect(again.body.error.code).toBe('MFA_INVALID');
    });

    it('two parallel uses of one code create one session', async () => {
      const admin = await createAdmin(app);
      const { mfaToken } = (await post('/admin/auth/login').send({ email: admin.email, password: admin.password })).body.data;
      const { secret } = (await post('/admin/auth/mfa/enrol').send({ mfaToken })).body.data;
      const code = totpCode(secret, totpStep());

      const results = await Promise.all(
        Array.from({ length: 5 }, () => post('/admin/auth/mfa/verify').send({ mfaToken, code })),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await prisma.adminSession.count()).toBe(1);
    });

    it('the MFA step needs the MFA token: a made-up, expired or wrong-kind token is refused', async () => {
      const admin = await createAdmin(app);
      const jwt = app.get(JwtService);
      const secret = (await import('../config/configuration.js')).default().jwt.adminSecret;
      const expired = await jwt.signAsync({ sub: admin.adminId, type: 'admin-mfa' }, { secret, audience: 'urgent-admin-mfa', expiresIn: -5 });
      const accessShaped = await jwt.signAsync({ sub: admin.adminId, sid: 'x', type: 'admin-access' }, { secret, audience: 'urgent-admin', expiresIn: 60 });

      for (const mfaToken of ['nonsense', expired, accessShaped]) {
        await post('/admin/auth/mfa/enrol').send({ mfaToken }).expect(401);
        await post('/admin/auth/mfa/verify').send({ mfaToken, code: '123456' }).expect(401);
      }
    });

    it('validates the code format', async () => {
      await post('/admin/auth/mfa/verify').send({ mfaToken: 'x', code: 'abcdef' }).expect(400);
      await post('/admin/auth/mfa/verify').send({ mfaToken: 'x', code: '12345' }).expect(400);
    });
  });

  describe('credentials', () => {
    it('answers wrong password, unknown email and a non-active admin identically', async () => {
      const admin = await createAdmin(app);
      const inactive = await createAdmin(app);
      await prisma.$executeRaw`UPDATE admins SET status = 'SUSPENDED'::"AdminStatus" WHERE id = ${inactive.adminId}::uuid`;

      const wrong = await post('/admin/auth/login').send({ email: admin.email, password: 'Wrong-password-1!' }).expect(401);
      const unknown = await post('/admin/auth/login').send({ email: 'nobody@urgent.ng', password: 'Wrong-password-1!' }).expect(401);
      const suspended = await post('/admin/auth/login').send({ email: inactive.email, password: inactive.password }).expect(401);

      expect(wrong.body.error).toEqual(unknown.body.error);
      expect(wrong.body.error).toEqual(suspended.body.error);
      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('matches the email in any case', async () => {
      const admin = await createAdmin(app, { email: 'boss@urgent.ng' });

      await post('/admin/auth/login').send({ email: ' BOSS@Urgent.NG ', password: admin.password }).expect(200);
    });

    it('locks after 10 failures (passwords and codes share the count) and says when to retry', async () => {
      const admin = await createAdmin(app);
      for (let i = 0; i < 10; i++) {
        await post('/admin/auth/login').send({ email: admin.email, password: 'Wrong-password-1!' }).expect(401);
      }

      const res = await post('/admin/auth/login').send({ email: admin.email, password: admin.password }).expect(429);

      expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
      expect(await prisma.adminAuthEvent.count({ where: { event: 'LOCKOUT' } })).toBe(1);
    });

    it('wrong MFA codes count toward the lockout too', async () => {
      const admin = await adminLogin(app, await createAdmin(app));
      const { mfaToken } = (await post('/admin/auth/login').send({ email: admin.email, password: admin.password })).body.data;

      for (let i = 0; i < 10; i++) {
        await post('/admin/auth/mfa/verify').send({ mfaToken, code: '000000' });
      }

      const res = await post('/admin/auth/mfa/verify').send({ mfaToken, code: await nextTotpCode(admin.secret!) }).expect(429);
      expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    });

    it('parallel password guesses cannot get past the limit', async () => {
      const admin = await createAdmin(app);

      await Promise.all(
        Array.from({ length: 25 }, () => post('/admin/auth/login').send({ email: admin.email, password: 'Wrong-password-1!' })),
      );

      const row = await prisma.admin.findUniqueOrThrow({ where: { id: admin.adminId } });
      expect(row.lockedUntil).not.toBeNull();
      await post('/admin/auth/login').send({ email: admin.email, password: admin.password }).expect(429);
    });

    it('records every attempt in the admin auth events', async () => {
      const admin = await createAdmin(app);
      await post('/admin/auth/login').send({ email: admin.email, password: 'Wrong-password-1!' });
      await post('/admin/auth/login').send({ email: 'nobody@urgent.ng', password: 'x' });
      await adminLogin(app, admin);

      const events = await prisma.adminAuthEvent.findMany({ orderBy: { createdAt: 'asc' } });

      expect(events.map((e) => e.event)).toEqual(['LOGIN_FAILED', 'LOGIN_FAILED', 'MFA_ENROLLED', 'LOGIN_SUCCESS']);
      expect(events[0].reason).toBe('WRONG_PASSWORD');
      expect(events[1].reason).toBe('UNKNOWN_ADMIN');
      expect(JSON.stringify(events)).not.toContain(admin.password);
    });

    it('auth events cannot be changed or deleted', async () => {
      const admin = await createAdmin(app);
      await post('/admin/auth/login').send({ email: admin.email, password: 'Wrong-password-1!' });

      await expect(prisma.$executeRaw`UPDATE admin_auth_events SET reason = 'x'`).rejects.toThrow(/immutable/);
      await expect(prisma.$executeRaw`DELETE FROM admin_auth_events`).rejects.toThrow(/not allowed/);
    });

    it('admin and role rows cannot be hard-deleted', async () => {
      await createAdmin(app);

      await expect(prisma.$executeRaw`DELETE FROM admins`).rejects.toThrow(/not allowed/);
      await expect(prisma.$executeRaw`DELETE FROM admin_roles`).rejects.toThrow(/not allowed/);
      await expect(prisma.$executeRaw`DELETE FROM admin_permissions`).rejects.toThrow(/not allowed/);
    });

    it('stores the password as an Argon2id hash and never returns it', async () => {
      const admin = await adminLogin(app, await createAdmin(app));

      const me = await get('/admin/auth/me', admin.accessToken).expect(200);

      expect(JSON.stringify(me.body)).not.toMatch(/argon2|passwordHash|mfaSecret/i);
      const row = await prisma.admin.findUniqueOrThrow({ where: { id: admin.adminId } });
      expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
    });
  });

  describe('a separate trust boundary', () => {
    it('a consumer token never works on an admin route', async () => {
      const user = await signedInUser(app);

      const res = await get('/admin/t/open', user.accessToken).expect(401);

      expect(res.body.error.code).toBe('AUTH_REQUIRED');
      await get('/admin/auth/me', user.accessToken).expect(401);
    });

    it('an admin token never works on a consumer route', async () => {
      const admin = await adminLogin(app, await createAdmin(app));

      await get('/me', admin.accessToken).expect(401);
      await get('/me/sessions', admin.accessToken).expect(401);
    });

    it('the admin cookie does not authenticate consumer routes and the consumer cookie not admin ones', async () => {
      const admin = await adminLogin(app, await createAdmin(app));

      await request(server()).get(`${API}/me`).set('Cookie', `ung_admin_at=${admin.accessToken}`).expect(401);
      await request(server()).get(`${API}/admin/t/open`).set('Cookie', `ung_at=${admin.accessToken}`).expect(401);
    });

    it('works with the admin cookie', async () => {
      const created = await createAdmin(app);
      const agent = request.agent(server());
      const first = await agent.post(`${API}/admin/auth/login`).send({ email: created.email, password: created.password });
      const { mfaToken } = first.body.data;
      const { secret } = (await agent.post(`${API}/admin/auth/mfa/enrol`).send({ mfaToken })).body.data;
      await agent.post(`${API}/admin/auth/mfa/verify`).send({ mfaToken, code: await nextTotpCode(secret) }).expect(200);

      await agent.get(`${API}/admin/auth/me`).expect(200);
    });

    it('rejects a token with the right audience but a consumer signature', async () => {
      const admin = await createAdmin(app);
      const forged = await app.get(JwtService).signAsync(
        { sub: admin.adminId, sid: 'x', type: 'admin-access' },
        { secret: process.env.JWT_SECRET || 'development-only-jwt-secret-not-for-production', audience: 'urgent-admin', expiresIn: 60 },
      );

      await get('/admin/t/open', forged).expect(401);
    });
  });

  describe('permissions (RBAC)', () => {
    it('passes with the permission and fails without it, naming what is missing', async () => {
      const support = await adminLogin(app, await createAdmin(app, { roles: ['SUPPORT_AGENT'] }));
      const finance = await adminLogin(app, await createAdmin(app, { roles: ['FINANCE'] }));

      await get('/admin/t/users', support.accessToken).expect(200);
      const denied = await get('/admin/t/users', finance.accessToken).expect(403);
      expect(denied.body.error.code).toBe('FORBIDDEN');
      expect(denied.body.error.details.missingPermissions).toEqual(['USERS_VIEW']);
    });

    it('needs every listed permission', async () => {
      const support = await adminLogin(app, await createAdmin(app, { roles: ['SUPPORT_AGENT'] }));
      const root = await adminLogin(app, await createAdmin(app, { roles: ['SUPER_ADMIN'] }));

      await get('/admin/t/both', support.accessToken).expect(403);
      await get('/admin/t/both', root.accessToken).expect(200);
    });

    it('authentication alone grants nothing sensitive', async () => {
      const finance = await adminLogin(app, await createAdmin(app, { roles: ['FINANCE'] }));

      await get('/admin/t/open', finance.accessToken).expect(200);
      await get('/admin/t/users', finance.accessToken).expect(403);
    });

    it('combines permissions from several roles', async () => {
      const both = await adminLogin(app, await createAdmin(app, { roles: ['SUPPORT_AGENT', 'FINANCE'] }));

      await get('/admin/t/both', both.accessToken).expect(200);
    });

    it('a role change takes effect on the very next request', async () => {
      const admin = await adminLogin(app, await createAdmin(app, { roles: ['SUPPORT_AGENT'] }));
      await get('/admin/t/users', admin.accessToken).expect(200);

      await prisma.$executeRaw`UPDATE admin_role_assignments SET deleted_at = now() WHERE admin_id = ${admin.adminId}::uuid`;

      await get('/admin/t/users', admin.accessToken).expect(403);
    });

    it('ignores soft-deleted roles and role permissions', async () => {
      const admin = await adminLogin(app, await createAdmin(app, { roles: ['SUPPORT_AGENT'] }));

      await prisma.$executeRaw`UPDATE admin_role_permissions SET deleted_at = now() WHERE permission_key = 'USERS_VIEW'`;
      await get('/admin/t/users', admin.accessToken).expect(403);
    });

    it('SUPER_ADMIN holds every permission in the PRD list', async () => {
      const root = await adminLogin(app, await createAdmin(app));

      const me = await get('/admin/auth/me', root.accessToken).expect(200);

      expect(me.body.data.permissions).toHaveLength(ADMIN_PERMISSIONS.length);
      expect(me.body.data.permissions).toContain('ADMIN_ACCOUNTS_MANAGE');
    });
  });

  describe('sessions', () => {
    it('a deactivated or suspended admin is refused on the next request and cannot refresh', async () => {
      const admin = await adminLogin(app, await createAdmin(app));
      await get('/admin/t/open', admin.accessToken).expect(200);

      await prisma.$executeRaw`UPDATE admins SET status = 'DEACTIVATED'::"AdminStatus" WHERE id = ${admin.adminId}::uuid`;

      await get('/admin/t/open', admin.accessToken).expect(401);
      await post('/admin/auth/refresh').send({ refreshToken: admin.refreshToken }).expect(401);
    });

    it('logout ends the session at once, even though the access token has not expired', async () => {
      const admin = await adminLogin(app, await createAdmin(app));

      await request(server()).post(`${API}/admin/auth/logout`).set(...bearer(admin.accessToken!)).expect(200);

      await get('/admin/t/open', admin.accessToken).expect(401);
      await post('/admin/auth/refresh').send({ refreshToken: admin.refreshToken }).expect(401);
    });

    it('an admin session can be revoked server-side', async () => {
      const admin = await adminLogin(app, await createAdmin(app));

      await prisma.$executeRaw`UPDATE admin_sessions SET revoked_at = now()`;

      await get('/admin/t/open', admin.accessToken).expect(401);
    });

    it('refresh rotates the token and retires the old one', async () => {
      const admin = await adminLogin(app, await createAdmin(app));

      const res = await post('/admin/auth/refresh').send({ refreshToken: admin.refreshToken }).expect(200);

      expect(res.body.data.refreshToken).not.toBe(admin.refreshToken);
      await get('/admin/t/open', res.body.data.accessToken).expect(200);
      await post('/admin/auth/refresh').send({ refreshToken: admin.refreshToken }).expect(401);
    });

    it('replaying an old refresh token ends the whole login and is recorded', async () => {
      const admin = await adminLogin(app, await createAdmin(app));
      const next = await post('/admin/auth/refresh').send({ refreshToken: admin.refreshToken }).expect(200);
      await prisma.$executeRaw`UPDATE admin_sessions SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL`;

      await post('/admin/auth/refresh').send({ refreshToken: admin.refreshToken }).expect(401);

      await post('/admin/auth/refresh').send({ refreshToken: next.body.data.refreshToken }).expect(401);
      await get('/admin/t/open', next.body.data.accessToken).expect(401);
      expect(await prisma.adminAuthEvent.count({ where: { event: 'TOKEN_REUSE' } })).toBe(1);
    });

    it('stores only a hash of the refresh token', async () => {
      const admin = await adminLogin(app, await createAdmin(app));

      expect(JSON.stringify(await prisma.adminSession.findMany())).not.toContain(admin.refreshToken!);
    });

    it('admin sessions are shorter than consumer sessions (configured in hours)', async () => {
      await adminLogin(app, await createAdmin(app));

      const [row] = await prisma.$queryRaw<Array<{ hours: number }>>`
        SELECT round(extract(epoch FROM (expires_at - now())) / 3600)::int AS hours FROM admin_sessions
      `;

      expect(row.hours).toBe(12);
    });

    it('refuses refresh with no token or junk', async () => {
      await post('/admin/auth/refresh').send({}).expect(401);
      await post('/admin/auth/refresh').send({ refreshToken: 'junk' }).expect(401);
    });
  });

  describe('no public admin registration', () => {
    it('has no way to create an admin over HTTP', async () => {
      await post('/admin/auth/register').send({ email: 'x@urgent.ng', password: 'Whatever-123456' }).expect(404);
      await post('/admin/admins').send({ email: 'x@urgent.ng' }).expect(404);
    });
  });
});

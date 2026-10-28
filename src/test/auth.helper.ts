/**
 * Helpers for HTTP-level tests of identity and access. They talk to the real app
 * (full AppModule, real PostgreSQL and Redis, fake external providers).
 */

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ConsentType } from '@prisma/client';
import { getTestPrisma, getTestRedis } from './database.helper.js';
import { OTP_PROVIDER } from '../common/providers/otp.provider.js';
import type { FakeOtpProvider } from '../common/providers/fakes/otp.fake.js';
import { AdminUserService } from '../admin/admin-user.service.js';
import { ADMIN_PERMISSIONS, DEFAULT_ADMIN_ROLES } from '../admin/admin.permissions.js';
import { totpCode, totpStep } from '../common/utils/totp.js';

export const API = '/api/v1';

/** Every policy type at version 1.0, as the seed does. */
export async function seedPolicies(): Promise<void> {
  const prisma = getTestPrisma();
  for (const type of Object.values(ConsentType)) {
    await prisma.$executeRaw`
      INSERT INTO policy_versions (type, version, document_ref, published_at)
      VALUES (${type}::"ConsentType", '1.0', ${`policies/${type}/1.0`}, date_trunc('milliseconds', now() - interval '1 minute'))
    `;
  }
}

/** Admin permissions and the default roles, as the seed does. */
export async function seedAdminRoles(): Promise<void> {
  const prisma = getTestPrisma();
  for (const key of ADMIN_PERMISSIONS) {
    await prisma.$executeRaw`INSERT INTO admin_permissions (key) VALUES (${key})`;
  }
  for (const [name, role] of Object.entries(DEFAULT_ADMIN_ROLES)) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO admin_roles (name, description, updated_at) VALUES (${name}, ${role.description}, now()) RETURNING id
    `;
    for (const permission of role.permissions) {
      await prisma.$executeRaw`
        INSERT INTO admin_role_permissions (role_id, permission_key) VALUES (${rows[0].id}::uuid, ${permission})
      `;
    }
  }
}

export const REQUIRED_CONSENTS = [
  { type: 'TERMS_OF_SERVICE', version: '1.0' },
  { type: 'PRIVACY_POLICY', version: '1.0' },
  { type: 'SAFETY_POLICY', version: '1.0' },
  { type: 'PROHIBITED_ITEMS_POLICY', version: '1.0' },
  { type: 'OFFLINE_PAYMENT_TERMS', version: '1.0' },
];

let phoneCounter = 0;
/** A unique valid Nigerian number per call. */
export function nextPhone(): string {
  phoneCounter += 1;
  return `+23480${String(30000000 + phoneCounter).padStart(8, '0')}`;
}

export function fakeOtp(app: INestApplication): FakeOtpProvider {
  return app.get<FakeOtpProvider>(OTP_PROVIDER);
}

/** The code the fake provider "sent" to this destination most recently. */
export function lastCode(app: INestApplication, destination: string): string {
  const calls = fakeOtp(app)
    .getCalls()
    .filter((call) => call.args[0] === destination);
  const last = calls[calls.length - 1];
  if (!last) {
    throw new Error(`No code was sent to ${destination}`);
  }
  return last.args[1] as string;
}

export interface TestUser {
  userId: string;
  phone: string;
  password: string;
}

export async function registerUser(
  app: INestApplication,
  overrides: Partial<{ phone: string; email: string; password: string; name: string }> = {},
): Promise<TestUser> {
  const phone = overrides.email ? undefined : (overrides.phone ?? nextPhone());
  const password = overrides.password ?? 'Str0ng-passw0rd!';
  const res = await request(app.getHttpServer())
    .post(`${API}/auth/register`)
    .send({
      name: overrides.name ?? 'Ada Obi',
      ...(phone ? { phone } : {}),
      ...(overrides.email ? { email: overrides.email } : {}),
      password,
      consents: REQUIRED_CONSENTS,
    });
  if (res.status !== 201) {
    throw new Error(`register failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return { userId: res.body.data.userId, phone: (phone ?? overrides.email) as string, password };
}

export async function verifyUser(app: INestApplication, user: TestUser): Promise<void> {
  const key = user.phone.startsWith('+') ? 'phone' : 'email';
  await request(app.getHttpServer())
    .post(`${API}/auth/otp/verify`)
    // A mobile client: the web path would also sign the new account in, and the tests log in on their own.
    .set('X-Client', 'mobile')
    .send({ [key]: user.phone, code: lastCode(app, user.phone) })
    .expect(200);
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/** Log in as a mobile client (tokens in the body). */
export async function loginMobile(app: INestApplication, user: TestUser): Promise<Tokens & { userId: string }> {
  const key = user.phone.startsWith('+') ? 'phone' : 'email';
  const res = await request(app.getHttpServer())
    .post(`${API}/auth/login`)
    .set('X-Client', 'mobile')
    .send({ [key]: user.phone, password: user.password })
    .expect(200);
  return res.body.data;
}

export const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];

/** Register, verify and log in. */
export async function signedInUser(app: INestApplication, overrides = {}) {
  const user = await registerUser(app, overrides);
  await verifyUser(app, user);
  const tokens = await loginMobile(app, user);
  return { ...user, ...tokens };
}

export interface TestAdmin {
  adminId: string;
  email: string;
  password: string;
  /** TOTP secret, available once MFA has been enrolled. */
  secret?: string;
  accessToken?: string;
  refreshToken?: string;
}

export async function createAdmin(
  app: INestApplication,
  options: { email?: string; roles?: string[]; password?: string } = {},
): Promise<TestAdmin> {
  const email = options.email ?? `admin${Date.now()}${Math.floor(Math.random() * 1000)}@urgent.ng`;
  const password = options.password ?? 'Admin-passw0rd-long!';
  const adminId = await app.get(AdminUserService).create({
    email,
    displayName: 'Test Admin',
    password,
    roles: options.roles ?? ['SUPER_ADMIN'],
  });
  return { adminId, email, password };
}

/** Full admin login: password, TOTP enrolment on the first login, then the TOTP code. */
export async function adminLogin(app: INestApplication, admin: TestAdmin): Promise<TestAdmin> {
  const server = app.getHttpServer();
  const first = await request(server)
    .post(`${API}/admin/auth/login`)
    .send({ email: admin.email, password: admin.password })
    .expect(200);
  const { status, mfaToken } = first.body.data;

  let secret = admin.secret;
  if (status === 'MFA_ENROLMENT_REQUIRED') {
    const enrol = await request(server).post(`${API}/admin/auth/mfa/enrol`).send({ mfaToken }).expect(200);
    secret = enrol.body.data.secret;
  }
  if (!secret) {
    throw new Error('Admin is enrolled but the test has no TOTP secret');
  }

  const verify = await request(server)
    .post(`${API}/admin/auth/mfa/verify`)
    .send({ mfaToken, code: await nextTotpCode(secret) })
    .expect(200);

  return {
    ...admin,
    secret,
    accessToken: verify.body.data.accessToken,
    refreshToken: verify.body.data.refreshToken,
  };
}

/**
 * A valid TOTP code for now. Clears the replay-protection keys first, so a test can log
 * in as the same admin several times inside one 30-second step.
 */
export async function nextTotpCode(secret: string): Promise<string> {
  const redis = getTestRedis();
  const keys = await redis.keys('admin:totp:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  return totpCode(secret, totpStep());
}

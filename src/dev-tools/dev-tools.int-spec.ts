/**
 * The dev-only one-time-code helper and the trusted-proxy setting.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, registerUser, seedPolicies, signedInUser } from '../test/auth.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Dev tools and trusted proxy', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();

  beforeAll(async () => {
    process.env.TRUST_PROXY_HOPS = '1';
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
  });
  afterAll(async () => {
    delete process.env.TRUST_PROXY_HOPS;
    await app.close();
  });

  it('returns the last one-time code sent to a destination', async () => {
    const user = await registerUser(app);
    const res = await request(app.getHttpServer()).get(`${API}/dev/last-otp`).query({ destination: user.phone }).expect(200);
    expect(res.body).toMatchObject({ destination: user.phone });
    expect(res.body.code).toMatch(/^\d{4,8}$/);

    // The code is the real one: it verifies the phone.
    await request(app.getHttpServer()).post(`${API}/auth/otp/verify`).send({ phone: user.phone, code: res.body.code }).expect(200);
    await request(app.getHttpServer()).get(`${API}/dev/last-otp`).query({ destination: '+2340000000000' }).expect(404);
  });

  it('takes the client address from X-Forwarded-For when one proxy hop is trusted', async () => {
    const user = await signedInUser(app);
    await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ phone: user.phone, password: user.password })
      .expect(200);
    const sessions = await prisma.$queryRaw<Array<{ ip: string | null }>>`
      SELECT host(ip) AS ip FROM auth_sessions WHERE user_id = ${user.userId}::uuid ORDER BY created_at DESC LIMIT 1
    `;
    expect(sessions[0].ip).toBe('203.0.113.9');
  });
});

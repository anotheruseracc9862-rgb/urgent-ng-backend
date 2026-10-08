import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../test/app.factory.js';
import { cleanAll } from '../../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../../test/auth.helper.js';

/**
 * The global limit counts a signed-in user on their own, not by IP. `POST /verification/attempts`
 * has the 5-per-minute `auth` policy and answers 400 to an empty body: the guard counts the call
 * before validation runs.
 */
describe('Rate limit per signed-in user', () => {
  let app: INestApplication;
  const previous = process.env.RATE_LIMIT_DISABLED;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    process.env.RATE_LIMIT_DISABLED = 'false';
    await cleanAll();
    await seedPolicies();
  });
  afterEach(() => {
    process.env.RATE_LIMIT_DISABLED = previous ?? 'true';
  });
  afterAll(async () => {
    await app.close();
  });

  let key = 0;
  const hit = (token?: string) => {
    const req = request(app.getHttpServer()).post(`${API}/verification/attempts`).set('Idempotency-Key', `k-${(key += 1)}`);
    return (token ? req.set(...bearer(token)) : req).send({});
  };

  it('does not make two users on one address share a budget', async () => {
    const a = await signedInUser(app);
    const b = await signedInUser(app);

    for (let i = 0; i < 5; i += 1) await hit(a.accessToken).expect(400);
    const blocked = await hit(a.accessToken).expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');

    // Same IP, different user: still has the whole budget.
    await hit(b.accessToken).expect(400);
  });

  it('keeps counting the same user across requests and gives a new user a fresh budget', async () => {
    const a = await signedInUser(app);
    for (let i = 0; i < 5; i += 1) await hit(a.accessToken);
    await hit(a.accessToken).expect(429);
    const c = await signedInUser(app);
    await hit(c.accessToken).expect(400);
  });

  it('counts a forged or expired token as anonymous (by address), never as the user it names', async () => {
    const victim = await signedInUser(app);
    const payload = Buffer.from(JSON.stringify({ sub: victim.userId, sid: 'x', type: 'access' })).toString('base64url');
    const forged = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.not-a-signature`;

    // Anonymous calls from this address use the address budget, not the victim's.
    for (let i = 0; i < 12; i += 1) await hit(forged);
    await hit(victim.accessToken).expect(400);
  });
});

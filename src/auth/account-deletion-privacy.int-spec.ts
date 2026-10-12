/**
 * P12-01 (done when): after a requester deletes their account and is anonymised, their personal
 * data appears in no API the other party can reach, while the marketplace records and the ratings
 * stay in place under "Deleted User".
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, registerUser, seedPolicies, verifyUser, loginMobile } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { completedScene } from '../test/assignment.helper.js';
import { AccountService } from './account.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Account deletion leaves no personal data behind (P12-01)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categoryId: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categoryId = (await seedCategories()).delivery;
  });
  afterAll(async () => {
    await app.close();
  });

  const NAME = 'Zebedee Quentin';
  const EMAIL = 'zebedee.quentin@example.com';

  async function requesterWithEmail() {
    const user = await registerUser(app, { email: EMAIL, name: NAME });
    await verifyUser(app, user);
    const tokens = await loginMobile(app, user);
    return { ...user, ...tokens };
  }

  it('anonymises the person and keeps ratings and records, with no trace in what the runner can read', async () => {
    const requester = await requesterWithEmail();
    const s = await completedScene(app, categoryId, { requester });
    const rate = (user: { accessToken: string }, body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post(`${API}/assignments/${s.assignmentId}/ratings`)
        .set(...bearer(user.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send(body);
    await rate(requester, { scores: { overall: 5 }, review: 'Quick and careful' }).expect(201);
    await rate(s.runner, { scores: { overall: 4 } }).expect(201);

    // The errand carries typed contacts and an address, and the person has a push device and a notification.
    await prisma.$executeRaw`
      INSERT INTO errand_contacts (errand_id, pickup_name, pickup_phone, dropoff_name, dropoff_phone, encryption_key_id, updated_at)
      VALUES (${s.errandId}::uuid, 'v1.k.pickupname', 'v1.k.pickupphone', 'v1.k.dropname', 'v1.k.dropphone', 'k', now())
    `;
    await prisma.$executeRaw`UPDATE errand_locations SET address_text = '12 Allen Avenue, Ikeja', landmark = 'Opposite the bank' WHERE errand_id = ${s.errandId}::uuid`;
    await request(app.getHttpServer())
      .post(`${API}/me/devices`)
      .set(...bearer(requester.accessToken))
      .send({ type: 'MOBILE_PUSH', pushToken: 'fcm-token-secret-1234' })
      .expect(201);
    await prisma.notification.create({
      data: { userId: requester.userId, category: 'TRANSACTIONAL', type: 'test', title: 'Hello Zebedee', body: 'Your errand' },
    });

    // Delete the account and run both sweeper steps.
    await request(app.getHttpServer()).post(`${API}/me/delete-request`).set(...bearer(requester.accessToken)).send({}).expect(200);
    await prisma.$executeRaw`UPDATE users SET deletion_scheduled_at = now() - interval '1 minute' WHERE id = ${requester.userId}::uuid`;
    const accounts = app.get(AccountService);
    expect(await accounts.finalizeDueDeletions()).toBe(1);
    await prisma.$executeRaw`UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = ${requester.userId}::uuid`;
    expect(await accounts.anonymiseDue()).toBe(1);

    // The row and the records stay.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: requester.userId } });
    expect(user).toMatchObject({ name: 'Deleted User', email: null, phoneE164: null, status: 'DELETED' });
    expect(await prisma.errand.count({ where: { id: s.errandId } })).toBe(1);
    expect(await prisma.rating.count({ where: { assignmentId: s.assignmentId } })).toBe(2);

    // What was typed and what was stored for delivery is gone.
    const contact = await prisma.errandContact.findUniqueOrThrow({ where: { errandId: s.errandId } });
    expect(contact).toMatchObject({ pickupName: null, pickupPhone: null, dropoffName: null, dropoffPhone: null });
    const [place] = await prisma.$queryRaw<Array<{ address_text: string | null; landmark: string | null }>>`
      SELECT address_text, landmark FROM errand_locations WHERE errand_id = ${s.errandId}::uuid
    `;
    expect(place).toEqual({ address_text: null, landmark: null });
    expect(await prisma.notification.count({ where: { userId: requester.userId } })).toBe(0);
    const device = await prisma.device.findFirstOrThrow({ where: { userId: requester.userId } });
    expect(device.pushToken).not.toContain('secret');

    // Everything the runner can read about the errand: no name, no email, no id of the person's login.
    const runnerGet = (path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(s.runner.accessToken));
    const seen = [
      (await runnerGet(`/assignments/${s.assignmentId}`).expect(200)).body,
      (await runnerGet(`/assignments/${s.assignmentId}/ratings`).expect(200)).body,
      (await runnerGet('/me/ratings').expect(200)).body,
      (await runnerGet('/conversations').expect(200)).body,
      (await runnerGet('/runner/assignments').expect(200)).body,
    ];
    const text = JSON.stringify(seen);
    expect(text).not.toContain('Zebedee');
    expect(text).not.toContain('Quentin');
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain('Allen Avenue');
    expect(text).not.toContain('Opposite the bank');
    expect(text).toContain('Deleted');
  });
});

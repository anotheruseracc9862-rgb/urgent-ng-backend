/**
 * What a runner tells us beside the NIN and the selfie: identity details, an ID document and a
 * guarantor. Kept for manual review, scrubbed on anonymisation. HTTP only, fake KYC provider.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, nextPhone, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { NIN } from '../test/verification.helper.js';
import { readyMedia } from '../test/media.helper.js';
import { VerificationService } from './verification.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Verification submission details', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
  });
  afterAll(async () => {
    await app.close();
  });

  const identity = {
    firstName: 'Ada',
    lastName: 'Okafor',
    dateOfBirth: '1994-03-21',
    addressLine: '12 Adeola Odeku Street',
    lga: 'Eti-Osa',
  };

  /** POST /verification/attempts with a fresh selfie. `.expect(status)` or `await` it. */
  function submit(user: { accessToken: string }, extra: Record<string, unknown>) {
    const run = async () => {
      const selfieMediaId = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');
      return request(app.getHttpServer())
        .post(`${API}/verification/attempts`)
        .set(...bearer(user.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({ nin: NIN.ok, selfieMediaId, identity, ...extra });
    };
    return {
      expect: async (status: number) => {
        const res = await run();
        expect(res.status, JSON.stringify(res.body)).toBe(status);
        return res;
      },
      // oxlint-disable-next-line unicorn/no-thenable -- a test helper that can be awaited or `.expect(status)`ed
      then: (resolve: (value: request.Response) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject),
    };
  }

  it('stores the identity details, the ID document and the guarantor with the attempt', async () => {
    const user = await signedInUser(app);
    const idMedia = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');

    const res = await submit(user, {
      identity,
      idDocument: { type: 'DRIVERS_LICENCE', mediaId: idMedia },
      guarantor: { fullName: 'Ngozi Okon', relationship: 'FAMILY', phone: '0803 456 7890' },
    }).expect(201);

    const stored = await app.get(VerificationService).getSubmission(res.body.data.id);
    expect(stored).toMatchObject({
      firstName: 'Ada',
      lastName: 'Okafor',
      dateOfBirth: '1994-03-21',
      addressLine: '12 Adeola Odeku Street',
      lga: 'Eti-Osa',
      idDocumentType: 'DRIVERS_LICENCE',
      idDocumentMediaId: idMedia,
      guarantorName: 'Ngozi Okon',
      guarantorRelationship: 'FAMILY',
      guarantorPhone: '+2348034567890',
    });
  });

  it('works with only the name and date of birth: no address, ID document or guarantor', async () => {
    const user = await signedInUser(app);

    const res = await submit(user, { identity: { firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1994-03-21' } }).expect(201);

    expect(res.body.data.status).toBe('VERIFIED');
    expect(await app.get(VerificationService).getSubmission(res.body.data.id)).toMatchObject({
      firstName: 'Ada',
      lastName: 'Okafor',
      dateOfBirth: '1994-03-21',
      addressLine: null,
      lga: null,
      idDocumentType: null,
      guarantorName: null,
    });
  });

  it('does not let the details or the guarantor decide the result', async () => {
    const user = await signedInUser(app);

    const res = await submit(user, {
      identity,
      guarantor: { fullName: 'Ngozi Okon', relationship: 'FRIEND', phone: nextPhone() },
    }).expect(201);

    expect(res.body.data.status).toBe('VERIFIED');
  });

  it('refuses a date of birth under 18', async () => {
    const user = await signedInUser(app);
    const year = new Date().getUTCFullYear() - 10;

    const res = await submit(user, { identity: { ...identity, dateOfBirth: `${year}-01-01` } }).expect(400);

    expect(res.body.error.details.field).toBe('identity.dateOfBirth');
    expect(await prisma.verificationAttempt.count({ where: { userId: user.userId } })).toBe(0);
  });

  it('refuses a malformed date, an unknown document type and a guarantor with the runner\'s own number', async () => {
    const user = await signedInUser(app);

    await submit(user, { identity: { ...identity, dateOfBirth: '21/03/1994' } }).expect(400);
    await submit(user, { idDocument: { type: 'STUDENT_CARD' } }).expect(400);
    const own = await submit(user, {
      guarantor: { fullName: 'Me Myself', relationship: 'FRIEND', phone: user.phone },
    }).expect(400);
    expect(own.body.error.details.field).toBe('guarantor.phone');
  });

  it('refuses an ID document photo that is the selfie, or that belongs to someone else', async () => {
    const user = await signedInUser(app);
    const other = await signedInUser(app);
    const selfie = await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT');
    const foreign = await readyMedia(app, other.accessToken, 'VERIFICATION_INPUT');

    await request(app.getHttpServer())
      .post(`${API}/verification/attempts`)
      .set(...bearer(user.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ nin: NIN.ok, selfieMediaId: selfie, identity, idDocument: { type: 'NIN_SLIP', mediaId: selfie } })
      .expect(400);
    const stolen = await submit(user, { idDocument: { type: 'NIN_SLIP', mediaId: foreign } });
    expect([400, 404]).toContain(stolen.status);
  });

  it('is scrubbed when the account is anonymised', async () => {
    const user = await signedInUser(app);
    const res = await submit(user, {
      identity,
      guarantor: { fullName: 'Ngozi Okon', relationship: 'EMPLOYER', phone: nextPhone() },
    }).expect(201);
    await prisma.$executeRaw`UPDATE users SET status = 'DELETED'::"UserStatus", deleted_at = now() - interval '400 days' WHERE id = ${user.userId}::uuid`;
    const { AccountService } = await import('../auth/account.service.js');

    await app.get(AccountService).anonymiseDue();

    const stored = await app.get(VerificationService).getSubmission(res.body.data.id);
    expect(stored).toMatchObject({ firstName: null, lastName: null, addressLine: null, guarantorName: null, guarantorPhone: null });
  });
});

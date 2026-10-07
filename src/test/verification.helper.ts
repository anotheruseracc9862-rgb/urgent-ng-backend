/** Helpers for verification and runner tests (real app, fake KYC provider). */

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { KYC_PROVIDER } from '../common/providers/kyc.provider.js';
import type { FakeKycProvider } from '../common/providers/fakes/kyc.fake.js';
import { API, bearer, signedInUser } from './auth.helper.js';
import { readyMedia } from './media.helper.js';

export type TestUser = Awaited<ReturnType<typeof signedInUser>>;

export const fakeKyc = (app: INestApplication) => app.get<FakeKycProvider>(KYC_PROVIDER);

/** NINs the fake provider answers deterministically (Backend PRD 10.3). */
export const NIN = {
  ok: '12345678901',
  other: '22345678901',
  selfieMismatch: '12345670000',
  notFound: '12345671111',
  timeout: '12345678888',
  providerError: '12345679999',
};

/** POST /verification/attempts with a fresh READY selfie (or the one given). */
export async function startVerification(
  app: INestApplication,
  user: TestUser,
  nin: string,
  options: { selfieMediaId?: string; idempotencyKey?: string } = {},
) {
  const selfieMediaId = options.selfieMediaId ?? (await readyMedia(app, user.accessToken, 'VERIFICATION_INPUT'));
  return request(app.getHttpServer())
    .post(`${API}/verification/attempts`)
    .set(...bearer(user.accessToken))
    .set('Idempotency-Key', options.idempotencyKey ?? randomUUID())
    .send({ nin, selfieMediaId });
}

/** A user whose verification succeeded. */
export async function verifiedUser(app: INestApplication, nin = NIN.ok): Promise<TestUser> {
  const user = await signedInUser(app);
  const res = await startVerification(app, user, nin);
  if (res.status !== 201 || res.body.data.status !== 'VERIFIED') {
    throw new Error(`verification failed in test setup: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return user;
}

export const profileBody = (overrides: Record<string, unknown> = {}) => ({
  transport: 'MOTORCYCLE',
  areaCenter: { lat: 6.5244, lng: 3.3792 },
  areaRadiusKm: 5,
  ...overrides,
});

/** A verified runner with a profile, set AVAILABLE. */
export async function readyRunner(app: INestApplication, nin = NIN.ok): Promise<TestUser> {
  const user = await verifiedUser(app, nin);
  await request(app.getHttpServer()).put(`${API}/runner/profile`).set(...bearer(user.accessToken)).send(profileBody()).expect(200);
  await request(app.getHttpServer()).put(`${API}/runner/availability`).set(...bearer(user.accessToken)).send({ availability: 'AVAILABLE' }).expect(200);
  return user;
}

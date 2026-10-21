/** Helpers for assignment and execution tests (real app over HTTP, fake providers). */

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { API, bearer, signedInUser } from './auth.helper.js';
import { readyRunner, type TestUser } from './verification.helper.js';
import { insertErrand } from './errand.helper.js';
import { submitOffer } from './offer.helper.js';

type Authed = { accessToken: string };

/** A distinct, valid NIN for the fake KYC provider (last four digits are not a scripted outcome). */
export const uniqueNin = (n: number): string => `5${String(n).padStart(6, '0')}1234`;

export const selectRunner = (
  app: INestApplication,
  requester: Authed,
  errandId: string,
  offerId: string,
  expectedOfferVersion: number,
  key = randomUUID(),
) =>
  request(app.getHttpServer())
    .post(`${API}/errands/${errandId}/select-runner`)
    .set(...bearer(requester.accessToken))
    .set('Idempotency-Key', key)
    .send({ offerId, expectedOfferVersion });

export const getAssignment = (app: INestApplication, user: Authed, assignmentId: string) =>
  request(app.getHttpServer()).get(`${API}/assignments/${assignmentId}`).set(...bearer(user.accessToken));

export interface Scene {
  requester: TestUser;
  runner: TestUser;
  errandId: string;
  offerId: string;
  offerVersion: number;
}

let ninCounter = 0;

/** A requester, an eligible runner, an open errand and the runner's active offer on it. */
export async function offerScene(
  app: INestApplication,
  categoryId: string,
  options: { requester?: TestUser; locationType?: 'ERRAND_PICKUP' | 'ERRAND_DESTINATION' } = {},
): Promise<Scene> {
  const requester = options.requester ?? (await signedInUser(app));
  ninCounter += 1;
  const runner = await readyRunner(app, uniqueNin(ninCounter));
  const errandId = await insertErrand({ requesterId: requester.userId, categoryId, locationType: options.locationType });
  const offer = (await submitOffer(app, runner, errandId).expect(201)).body.data;
  return { requester, runner, errandId, offerId: offer.id, offerVersion: offer.version };
}

/** Another eligible runner offering on the same errand. */
export async function addOffer(app: INestApplication, errandId: string, extra: Record<string, unknown> = {}) {
  ninCounter += 1;
  const runner = await readyRunner(app, uniqueNin(ninCounter));
  const offer = (await submitOffer(app, runner, errandId, extra).expect(201)).body.data;
  return { runner, offerId: offer.id as string, offerVersion: offer.version as number };
}

export const acceptAssignment = (app: INestApplication, runner: Authed, assignmentId: string, key = randomUUID()) =>
  request(app.getHttpServer())
    .post(`${API}/assignments/${assignmentId}/accept`)
    .set(...bearer(runner.accessToken))
    .set('Idempotency-Key', key)
    .send({});

export const declineAssignment = (app: INestApplication, runner: Authed, assignmentId: string) =>
  request(app.getHttpServer()).post(`${API}/assignments/${assignmentId}/decline`).set(...bearer(runner.accessToken)).send({});

/** Select the scene's offer over HTTP and return the scene plus the assignment id. */
export async function selectedScene(app: INestApplication, categoryId: string, options: { requester?: TestUser; locationType?: 'ERRAND_PICKUP' | 'ERRAND_DESTINATION' } = {}) {
  const scene = await offerScene(app, categoryId, options);
  const res = await selectRunner(app, scene.requester, scene.errandId, scene.offerId, scene.offerVersion).expect(201);
  return { ...scene, assignmentId: res.body.data.id as string };
}

export const executionStep = (
  app: INestApplication,
  runner: Authed,
  assignmentId: string,
  name: 'start' | 'pickup' | 'deliver',
  body: Record<string, unknown> = {},
  key = randomUUID(),
) =>
  request(app.getHttpServer())
    .post(`${API}/assignments/${assignmentId}/${name}`)
    .set(...bearer(runner.accessToken))
    .set('Idempotency-Key', key)
    .send(body);

export const completeErrand = (app: INestApplication, requester: Authed, errandId: string, key = randomUUID()) =>
  request(app.getHttpServer())
    .post(`${API}/errands/${errandId}/complete`)
    .set(...bearer(requester.accessToken))
    .set('Idempotency-Key', key)
    .send({});

export const cancelAssignment = (
  app: INestApplication,
  user: Authed,
  assignmentId: string,
  body: Record<string, unknown> = { reason: 'REQUESTER_CANCELLED' },
  key = randomUUID(),
) =>
  request(app.getHttpServer())
    .post(`${API}/assignments/${assignmentId}/cancel`)
    .set(...bearer(user.accessToken))
    .set('Idempotency-Key', key)
    .send(body);

/** Select and accept: the errand is ACCEPTED. */
export async function acceptedScene(app: INestApplication, categoryId: string, options: { requester?: TestUser; locationType?: 'ERRAND_PICKUP' | 'ERRAND_DESTINATION' } = {}) {
  const scene = await selectedScene(app, categoryId, options);
  await acceptAssignment(app, scene.runner, scene.assignmentId).expect(201);
  return scene;
}

/** Select, accept, start, pick up, deliver and complete: the errand and assignment are COMPLETED. */
export async function completedScene(app: INestApplication, categoryId: string, options: { requester?: TestUser } = {}) {
  const scene = await acceptedScene(app, categoryId, options);
  for (const name of ['start', 'pickup', 'deliver'] as const) {
    await executionStep(app, scene.runner, scene.assignmentId, name).expect(201);
  }
  await completeErrand(app, scene.requester, scene.errandId).expect(201);
  return scene;
}

/** Another completed errand for an existing runner, from a new requester (or the one given). */
export async function completedFor(
  app: INestApplication,
  categoryId: string,
  runner: Authed,
  options: { requester?: TestUser } = {},
) {
  const requester = options.requester ?? (await signedInUser(app));
  const errandId = await insertErrand({ requesterId: requester.userId, categoryId });
  const offer = (await submitOffer(app, runner, errandId).expect(201)).body.data;
  const selected = await selectRunner(app, requester, errandId, offer.id, offer.version).expect(201);
  const assignmentId = selected.body.data.id as string;
  await acceptAssignment(app, runner, assignmentId).expect(201);
  for (const name of ['start', 'pickup', 'deliver'] as const) {
    await executionStep(app, runner, assignmentId, name).expect(201);
  }
  await completeErrand(app, requester, errandId).expect(201);
  return { requester, errandId, assignmentId };
}

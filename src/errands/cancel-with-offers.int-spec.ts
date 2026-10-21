/**
 * Cancelling an open errand that already has offers on it: the offers close, the runner is told, and the
 * requester gets a clear answer, not a 404.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { addOffer, offerScene } from '../test/assignment.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Cancelling an open errand that has offers', () => {
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

  const cancel = (user: { accessToken: string }, errandId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`${API}/errands/${errandId}/cancel`).set(...bearer(user.accessToken)).send(body);

  it('cancels with no reason, closes every offer and keeps the errand on record', async () => {
    const scene = await offerScene(app, categoryId);
    await addOffer(app, scene.errandId);

    const res = await cancel(scene.requester, scene.errandId, {});

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'REQUESTER_CANCELLED' });
    const offers = await prisma.offer.findMany({ where: { errandId: scene.errandId } });
    expect(offers).toHaveLength(2);
    expect(offers.every((offer) => offer.status !== 'ACTIVE')).toBe(true);
  });

  it('cancels with a reason and a note too', async () => {
    const scene = await offerScene(app, categoryId);
    const res = await cancel(scene.requester, scene.errandId, { reason: 'NO_RUNNER_AVAILABLE', note: 'too slow' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'NO_RUNNER_AVAILABLE' });
  });

  it('is a 404 only for someone who does not own the errand: the runner who made the offer cannot cancel it this way', async () => {
    const scene = await offerScene(app, categoryId);
    const res = await cancel(scene.runner, scene.errandId, { reason: 'REQUESTER_CANCELLED' });
    expect(res.status).toBe(404);
    expect((await prisma.errand.findUniqueOrThrow({ where: { id: scene.errandId } })).status).toBe('OPEN');
  });
});

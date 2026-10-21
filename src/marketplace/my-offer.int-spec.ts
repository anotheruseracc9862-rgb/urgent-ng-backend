/**
 * A runner's own live offer on an errand shows on the feed, the detail and the saved list, so a card can
 * say "Offer sent" without opening it. Nobody else's offer is ever shown.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll } from '../test/database.helper.js';
import { API, bearer, seedPolicies } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { offerScene, uniqueNin } from '../test/assignment.helper.js';
import { offerAction } from '../test/offer.helper.js';
import { readyRunner } from '../test/verification.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('My offer on the marketplace', () => {
  let app: INestApplication;
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

  type Authed = { accessToken: string };
  const feed = async (user: Authed) =>
    (await request(app.getHttpServer()).get(`${API}/marketplace/errands`).set(...bearer(user.accessToken)).expect(200)).body.data as Array<{ id: string; myOffer: Record<string, unknown> | null }>;
  const detail = async (user: Authed, errandId: string) =>
    (await request(app.getHttpServer()).get(`${API}/marketplace/errands/${errandId}`).set(...bearer(user.accessToken)).expect(200)).body.data as { myOffer: Record<string, unknown> | null };

  it('shows the runner their own offer on the feed and the detail, with its terms', async () => {
    const scene = await offerScene(app, categoryId);

    const item = (await feed(scene.runner)).find((candidate) => candidate.id === scene.errandId);
    expect(item?.myOffer).toEqual({ id: scene.offerId, amountMinor: 50_000, durationMinutes: 30, awaitingParty: 'REQUESTER', needsReconfirmation: false });
    expect((await detail(scene.runner, scene.errandId)).myOffer).toMatchObject({ id: scene.offerId, awaitingParty: 'REQUESTER' });
  });

  it('shows another runner no offer at all: only your own is yours to see', async () => {
    const scene = await offerScene(app, categoryId);
    const other = await readyRunner(app, uniqueNin(777));

    const item = (await feed(other)).find((candidate) => candidate.id === scene.errandId);
    expect(item).toBeDefined();
    expect(item?.myOffer).toBeNull();
    expect((await detail(other, scene.errandId)).myOffer).toBeNull();
  });

  it('says it is the runner\'s move when a counter has come in', async () => {
    const scene = await offerScene(app, categoryId);
    await offerAction(app, scene.requester, 'post', scene.offerId, 'counter', { amountMinor: 40_000, durationMinutes: 30, expectedVersion: scene.offerVersion }).expect(200);

    const item = (await feed(scene.runner)).find((candidate) => candidate.id === scene.errandId);
    expect(item?.myOffer).toMatchObject({ amountMinor: 40_000, awaitingParty: 'RUNNER' });
  });

  it('stops showing an offer once it is withdrawn', async () => {
    const scene = await offerScene(app, categoryId);
    await offerAction(app, scene.runner, 'post', scene.offerId, 'withdraw').expect(200);

    const item = (await feed(scene.runner)).find((candidate) => candidate.id === scene.errandId);
    expect(item?.myOffer ?? null).toBeNull();
    expect((await detail(scene.runner, scene.errandId)).myOffer).toBeNull();
  });
});

/**
 * The requester's offers across all their errands: one list, newest first, only their own.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { offerScene } from '../test/assignment.helper.js';
import { offerAction } from '../test/offer.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Requester offers', () => {
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
  const list = (user: Authed, query = '') =>
    request(app.getHttpServer()).get(`${API}/requester/offers${query}`).set(...bearer(user.accessToken));

  it('lists the offers on the requester\'s errands, with the runner and whose move it is', async () => {
    const scene = await offerScene(app, categoryId);

    const rows = (await list(scene.requester).expect(200)).body.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: scene.offerId,
      errandId: scene.errandId,
      status: 'ACTIVE',
      awaitingParty: 'REQUESTER',
      amountMinor: 50_000,
      categoryFlow: 'TRANSIT',
      runnerCompletedErrands: 0,
    });
    expect(typeof rows[0].runnerFirstName).toBe('string');
    expect(rows[0].errandTitle).toBeTruthy();
    // No contact, no surname, no exact place.
    expect(JSON.stringify(rows[0])).not.toMatch(/phone|email|exact|runnerId|lastName/i);
  });

  it('shows nobody else\'s offers: not another requester, and not the runner who made them', async () => {
    const scene = await offerScene(app, categoryId);
    const stranger = await signedInUser(app);

    expect((await list(stranger).expect(200)).body.data).toEqual([]);
    expect((await list(scene.runner).expect(200)).body.data).toEqual([]);
  });

  it('keeps an offer after it ends and filters by status', async () => {
    const scene = await offerScene(app, categoryId);
    await offerAction(app, scene.requester, 'post', scene.offerId, 'reject').expect(200);

    expect(((await list(scene.requester).expect(200)).body.data as Array<{ status: string }>).map((row) => row.status)).toEqual(['REJECTED']);
    expect((await list(scene.requester, '?status=ACTIVE').expect(200)).body.data).toEqual([]);
    expect((await list(scene.requester, '?status=REJECTED').expect(200)).body.data).toHaveLength(1);
    await list(scene.requester, '?status=NOPE').expect(400);
  });

  it('pages newest first', async () => {
    const first = await offerScene(app, categoryId);
    const res = await list(first.requester, '?limit=1').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.hasNextPage ?? false).toBe(false);
  });
});

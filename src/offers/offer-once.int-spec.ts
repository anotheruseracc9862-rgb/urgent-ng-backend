/**
 * One offer per runner per errand, for good. A live offer is edited, not repeated; a declined or
 * withdrawn one is not made again. The limit is the MAX_OFFER_PER_RUNNER_PER_ERRAND setting.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll } from '../test/database.helper.js';
import { API, bearer, seedPolicies } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { addOffer, offerScene } from '../test/assignment.helper.js';
import { offerAction, submitOffer } from '../test/offer.helper.js';
import { BusinessConfigService } from '../config/business-config.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('One offer per runner per errand', () => {
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

  const used = async (user: { accessToken: string }) =>
    (await request(app.getHttpServer()).get(`${API}/runner/offer-limit`).set(...bearer(user.accessToken)).expect(200)).body.data.used as number;

  it('refuses a second offer while the first is live, and says to edit it', async () => {
    const scene = await offerScene(app, categoryId);
    const res = await submitOffer(app, scene.runner, scene.errandId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OFFER_ALREADY_EXISTS');
  });

  it('refuses a new offer after the runner withdrew, so a withdrawal cannot restart the negotiation', async () => {
    const scene = await offerScene(app, categoryId);
    await offerAction(app, scene.runner, 'post', scene.offerId, 'withdraw').expect(200);

    const res = await submitOffer(app, scene.runner, scene.errandId);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OFFER_NOT_ELIGIBLE');
    expect(res.body.error.details).toMatchObject({ reasons: ['PREVIOUS_OFFER_ENDED'], previousStatus: 'WITHDRAWN' });
    expect(res.body.error.message).toBe('You already made an offer on this errand. Only one offer is allowed.');
  });

  it('refuses a new offer after the requester declined, and says so', async () => {
    const scene = await offerScene(app, categoryId);
    await offerAction(app, scene.requester, 'post', scene.offerId, 'reject').expect(200);

    const res = await submitOffer(app, scene.runner, scene.errandId);

    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ reasons: ['PREVIOUS_OFFER_DECLINED'], previousStatus: 'REJECTED' });
    expect(res.body.error.message).toBe('The requester declined your offer on this errand.');
  });

  it('does not use up one of the runner\'s daily offers on a refused attempt', async () => {
    const scene = await offerScene(app, categoryId);
    await offerAction(app, scene.runner, 'post', scene.offerId, 'withdraw').expect(200);
    const before = await used(scene.runner);

    await submitOffer(app, scene.runner, scene.errandId).expect(403);
    await submitOffer(app, scene.runner, scene.errandId).expect(403);

    expect(await used(scene.runner)).toBe(before);
  });

  it('leaves every other runner free to offer on the same errand', async () => {
    const scene = await offerScene(app, categoryId);
    await offerAction(app, scene.runner, 'post', scene.offerId, 'withdraw').expect(200);

    const other = await addOffer(app, scene.errandId);

    expect(other.offerId).toBeTruthy();
  });

  it('leaves the same runner free to offer on a different errand', async () => {
    const first = await offerScene(app, categoryId);
    await offerAction(app, first.runner, 'post', first.offerId, 'withdraw').expect(200);
    const second = await offerScene(app, categoryId);

    expect((await submitOffer(app, first.runner, second.errandId)).status).toBe(201);
  });

  it('follows the setting: raise the limit to two and a withdrawn runner may offer once more, but no further', async () => {
    await app.get(BusinessConfigService).set('MAX_OFFER_PER_RUNNER_PER_ERRAND', 2);
    const scene = await offerScene(app, categoryId);
    await offerAction(app, scene.runner, 'post', scene.offerId, 'withdraw').expect(200);

    const again = await submitOffer(app, scene.runner, scene.errandId);
    expect(again.status).toBe(201);

    await offerAction(app, scene.runner, 'post', again.body.data.id, 'withdraw').expect(200);
    const third = await submitOffer(app, scene.runner, scene.errandId);
    expect(third.status).toBe(403);
    expect(third.body.error.details.reasons).toEqual(['PREVIOUS_OFFER_ENDED']);
  });
});

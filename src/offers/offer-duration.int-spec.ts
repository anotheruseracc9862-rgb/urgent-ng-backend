/**
 * How long a runner may say a job will take. A delivery is quoted within a day; a service may take days,
 * so its limit is higher. The limit is the server's: the category tells clients what it is.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll } from '../test/database.helper.js';
import { API, seedPolicies } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { addOffer, offerScene } from '../test/assignment.helper.js';
import { offerAction, submitOffer } from '../test/offer.helper.js';
import { readyRunner } from '../test/verification.helper.js';
import { uniqueNin } from '../test/assignment.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

const DAY = 24 * 60;

describe('Offer duration limits', () => {
  let app: INestApplication;
  let ids: Record<string, string>;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    ids = await seedCategories();
  });
  afterAll(async () => {
    await app.close();
  });

  let nin = 900;
  const newRunner = () => readyRunner(app, uniqueNin((nin += 1)));

  it('tells clients the limit for each category', async () => {
    const res = await request(app.getHttpServer()).get(`${API}/reference/categories`).expect(200);
    const limits = Object.fromEntries(res.body.data.map((c: { key: string; maxOfferMinutes: number }) => [c.key, c.maxOfferMinutes]));
    expect(limits).toMatchObject({ delivery: DAY, pickup: DAY, shopping_purchase: DAY, home_cleaning: 14 * DAY });
  });

  describe('a delivery-style errand', () => {
    it('allows a full day and refuses more, naming the limit', async () => {
      const scene = await offerScene(app, ids.delivery);
      await addOffer(app, scene.errandId, { durationMinutes: DAY });

      const runner = await newRunner();
      const res = await submitOffer(app, runner, scene.errandId, { durationMinutes: 2 * DAY });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toMatchObject({ field: 'durationMinutes', maxDuration: DAY });
    });
  });

  describe('a service', () => {
    it('allows quoting several days, up to 14', async () => {
      const scene = await offerScene(app, ids.home_cleaning, { locationType: 'ERRAND_DESTINATION' });
      const three = await addOffer(app, scene.errandId, { durationMinutes: 3 * DAY });
      expect(three.offerId).toBeTruthy();
      await addOffer(app, scene.errandId, { durationMinutes: 14 * DAY });
    });

    it('refuses more than 14 days, naming the limit', async () => {
      const scene = await offerScene(app, ids.home_cleaning, { locationType: 'ERRAND_DESTINATION' });
      const runner = await newRunner();
      const res = await submitOffer(app, runner, scene.errandId, { durationMinutes: 15 * DAY });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toMatchObject({ field: 'durationMinutes', maxDuration: 14 * DAY });
    });

    it('applies the same limits to a counter-offer', async () => {
      const scene = await offerScene(app, ids.home_cleaning, { locationType: 'ERRAND_DESTINATION' });
      const body = { amountMinor: 60_000, expectedVersion: scene.offerVersion };

      const tooLong = await offerAction(app, scene.requester, 'post', scene.offerId, 'counter', { ...body, durationMinutes: 15 * DAY });
      expect(tooLong.status).toBe(400);

      const fine = await offerAction(app, scene.requester, 'post', scene.offerId, 'counter', { ...body, durationMinutes: 5 * DAY });
      expect(fine.status).toBe(200);
      expect(fine.body.data.durationMinutes).toBe(5 * DAY);
    });
  });

  it('tells both sides of a negotiation how long an estimate may be on this errand', async () => {
    const delivery = await offerScene(app, ids.delivery);
    const service = await offerScene(app, ids.home_cleaning, { locationType: 'ERRAND_DESTINATION' });

    const forDelivery = await offerAction(app, delivery.requester, 'get', delivery.offerId, '');
    expect(forDelivery.body.data.maxDurationMinutes).toBe(DAY);
    const forService = await offerAction(app, service.runner, 'get', service.offerId, '');
    expect(forService.body.data.maxDurationMinutes).toBe(14 * DAY);
  });

  it('still refuses a nonsense duration before it reaches the limit check', async () => {
    const scene = await offerScene(app, ids.home_cleaning, { locationType: 'ERRAND_DESTINATION' });
    const runner = await newRunner();
    expect((await submitOffer(app, runner, scene.errandId, { durationMinutes: 0 })).status).toBe(400);
    expect((await submitOffer(app, runner, scene.errandId, { durationMinutes: 1_000_000 })).status).toBe(400);
    expect((await submitOffer(app, runner, scene.errandId, { durationMinutes: 1.5 })).status).toBe(400);
  });
});

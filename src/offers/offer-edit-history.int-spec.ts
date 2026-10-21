/**
 * A runner changing their own offer is recorded as an edit, not as a counter-offer: the price path must
 * not say someone countered when nobody could. It uses no negotiation round, and a real counter still does.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll } from '../test/database.helper.js';
import { seedPolicies } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { offerScene } from '../test/assignment.helper.js';
import { offerAction } from '../test/offer.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('The history of an edited offer', () => {
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

  const history = async (scene: { requester: { accessToken: string }; offerId: string }) =>
    (await offerAction(app, scene.requester, 'get', scene.offerId, '').expect(200)).body.data as {
      roundsUsed: number;
      history: Array<{ type: string; amountMinor: number | null; durationMinutes: number | null; actorUserId: string }>;
    };

  it('records the runner changing their own offer as an edit, and uses no round', async () => {
    const scene = await offerScene(app, categoryId);

    await offerAction(app, scene.runner, 'patch', scene.offerId, '', { amountMinor: 75_000, durationMinutes: 45, expectedVersion: scene.offerVersion }).expect(200);

    const view = await history(scene);
    expect(view.history.map((event) => event.type)).toEqual(['INITIAL_OFFER', 'OFFER_EDIT']);
    expect(view.history[1]).toMatchObject({ amountMinor: 75_000, durationMinutes: 45, actorUserId: scene.runner.userId });
    expect(view.roundsUsed).toBe(0);
  });

  it('keeps a real counter a counter, and it still uses a round', async () => {
    const scene = await offerScene(app, categoryId);

    await offerAction(app, scene.requester, 'post', scene.offerId, 'counter', { amountMinor: 40_000, durationMinutes: 30, expectedVersion: scene.offerVersion }).expect(200);

    const view = await history(scene);
    expect(view.history.map((event) => event.type)).toEqual(['INITIAL_OFFER', 'COUNTER_OFFER']);
    expect(view.roundsUsed).toBe(1);
  });

  it('shows each change in order when an offer is edited more than once', async () => {
    const scene = await offerScene(app, categoryId);
    const first = await offerAction(app, scene.runner, 'patch', scene.offerId, '', { amountMinor: 60_000, durationMinutes: 30, expectedVersion: scene.offerVersion }).expect(200);
    await offerAction(app, scene.runner, 'patch', scene.offerId, '', { amountMinor: 70_000, durationMinutes: 60, expectedVersion: first.body.data.version }).expect(200);

    const view = await history(scene);
    expect(view.history.map((event) => [event.type, event.amountMinor])).toEqual([
      ['INITIAL_OFFER', 50_000],
      ['OFFER_EDIT', 60_000],
      ['OFFER_EDIT', 70_000],
    ]);
    expect(view.roundsUsed).toBe(0);
  });
});

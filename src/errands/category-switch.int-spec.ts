/**
 * Switching the category of an errand that is already posted. The new category may need a place the
 * errand does not have yet, or forbid one it has. Every combination must end in a clear answer, never
 * a server error, and a refused switch must leave the errand exactly as it was.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { createDraft, draftBody, LAGOS_DESTINATION, LAGOS_PICKUP, publishErrand, seedCategories } from '../test/errand.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Switching the category of an errand', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
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

  type Authed = { accessToken: string };
  const patch = (user: Authed, errandId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).patch(`${API}/errands/${errandId}`).set(...bearer(user.accessToken)).send(body);
  const get = (user: Authed, errandId: string) =>
    request(app.getHttpServer()).get(`${API}/errands/${errandId}`).set(...bearer(user.accessToken));

  const place = (point: { lat: number; lng: number }, extra: Record<string, unknown> = {}) => ({ point, ...extra });

  /** A posted (or draft) errand in the named category, with exactly the places that category takes. */
  async function errandIn(user: Authed, key: string, options: { publish?: boolean } = {}) {
    const base = draftBody(ids[key], { title: 'Switch me', description: 'Something to do' });
    const { pickup: _pickup, destination: _destination, ...bare } = base;
    const body: Record<string, unknown> = { ...bare };
    if (key === 'delivery') { body.pickup = base.pickup; body.destination = base.destination; }
    if (key === 'pickup' || key === 'other') body.pickup = base.pickup;
    if (key === 'shopping_purchase' || key === 'home_cleaning') body.destination = base.destination;
    const draft = await createDraft(app, user, body).expect(201);
    if (options.publish !== false) await publishErrand(app, user, draft.body.data.id).expect(201);
    return draft.body.data.id as string;
  }

  const state = async (user: Authed, id: string) => {
    const data = (await get(user, id).expect(200)).body.data;
    return { category: data.category.key as string, pickup: data.pickup !== null, destination: data.destination !== null, version: data.version as number };
  };

  describe('an open errand', () => {
    it('shopping to pickup, sent as the form sends it, is refused clearly and changes nothing', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'shopping_purchase');
      const before = await state(user, id);

      const res = await patch(user, id, { categoryId: ids.pickup, destination: null, expectedVersion: before.version });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('ERRAND_NOT_ELIGIBLE');
      expect(res.body.error.details.problems).toEqual(expect.arrayContaining([{ field: 'pickup', code: 'REQUIRED' }]));
      expect(await state(user, id)).toEqual(before);
    });

    it('shopping to pickup works when the pickup comes with it', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'shopping_purchase');
      const { version } = await state(user, id);

      await patch(user, id, { categoryId: ids.pickup, destination: null, pickup: place(LAGOS_PICKUP), expectedVersion: version }).expect(200);

      expect(await state(user, id)).toMatchObject({ category: 'pickup', pickup: true, destination: false });
    });

    it('delivery to a service needs the pickup dropped and keeps the one address', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'delivery');
      const { version } = await state(user, id);

      await patch(user, id, { categoryId: ids.home_cleaning, pickup: null, expectedVersion: version }).expect(200);

      expect(await state(user, id)).toMatchObject({ category: 'home_cleaning', pickup: false, destination: true });
    });

    it('delivery to a service is refused when the pickup is left in place', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'delivery');
      const before = await state(user, id);

      const res = await patch(user, id, { categoryId: ids.home_cleaning, expectedVersion: before.version });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('ERRAND_NOT_ELIGIBLE');
      expect(await state(user, id)).toEqual(before);
    });

    it('a service to delivery is refused until a pickup is given, and works with one', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'home_cleaning');
      const before = await state(user, id);

      const refused = await patch(user, id, { categoryId: ids.delivery, expectedVersion: before.version });
      expect(refused.status).toBe(422);
      expect(await state(user, id)).toEqual(before);

      await patch(user, id, { categoryId: ids.delivery, pickup: place(LAGOS_PICKUP), expectedVersion: before.version }).expect(200);
      expect(await state(user, id)).toMatchObject({ category: 'delivery', pickup: true, destination: true });
    });

    it('delivery to shopping drops the pickup and keeps the drop-off', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'delivery');
      const { version } = await state(user, id);

      await patch(user, id, { categoryId: ids.shopping_purchase, pickup: null, expectedVersion: version }).expect(200);

      expect(await state(user, id)).toMatchObject({ category: 'shopping_purchase', pickup: false, destination: true });
    });

    it('delivery to shopping that leaves the pickup in place still works: the extra pickup is allowed', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'delivery');
      const { version } = await state(user, id);

      await patch(user, id, { categoryId: ids.shopping_purchase, expectedVersion: version }).expect(200);
    });

    it('pickup to delivery needs a drop-off', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'pickup');
      const before = await state(user, id);

      const refused = await patch(user, id, { categoryId: ids.delivery, expectedVersion: before.version });
      expect(refused.status).toBe(422);
      expect(refused.body.error.details.problems).toEqual(expect.arrayContaining([{ field: 'destination', code: 'REQUIRED' }]));

      await patch(user, id, { categoryId: ids.delivery, destination: place(LAGOS_DESTINATION), expectedVersion: before.version }).expect(200);
    });

    it('removing every place from a posted errand is refused clearly, not with a server error', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'delivery');
      const before = await state(user, id);

      const res = await patch(user, id, { pickup: null, destination: null, expectedVersion: before.version });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('ERRAND_NOT_ELIGIBLE');
      expect(await state(user, id)).toEqual(before);
    });

    it('a category that does not exist, or is switched off, is refused clearly', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'delivery');
      const { version } = await state(user, id);

      const missing = await patch(user, id, { categoryId: '00000000-0000-4000-8000-000000000000', expectedVersion: version });
      expect(missing.status).toBe(400);

      await prisma.category.update({ where: { id: ids.pickup }, data: { active: false } });
      const off = await patch(user, id, { categoryId: ids.pickup, expectedVersion: version });
      expect(off.status).toBe(400);
      expect(off.body.error.details).toMatchObject({ field: 'categoryId' });
    });

    it('a successful switch flags the offers for reconfirmation and counts as a material change', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'delivery');
      const { version } = await state(user, id);

      await patch(user, id, { categoryId: ids.shopping_purchase, pickup: null, expectedVersion: version }).expect(200);

      const row = await prisma.errand.findUniqueOrThrow({ where: { id } });
      expect(row.materialVersion).toBe(1);
      expect(await prisma.errandVersion.count({ where: { errandId: id } })).toBe(1);
    });
  });

  describe('a draft', () => {
    it('switches to any category, even one whose places are not set yet', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'shopping_purchase', { publish: false });
      const { version } = await state(user, id);

      await patch(user, id, { categoryId: ids.pickup, destination: null, expectedVersion: version }).expect(200);

      expect(await state(user, id)).toMatchObject({ category: 'pickup', pickup: false, destination: false });
    });
  });

  describe('once a runner is selected', () => {
    it('is refused with a clear state error, not a server error', async () => {
      const user = await signedInUser(app);
      const id = await errandIn(user, 'delivery');
      await prisma.errand.update({ where: { id }, data: { status: 'RUNNER_SELECTED' } });

      const res = await patch(user, id, { categoryId: ids.pickup });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ERRAND_INVALID_STATE');
    });
  });
});

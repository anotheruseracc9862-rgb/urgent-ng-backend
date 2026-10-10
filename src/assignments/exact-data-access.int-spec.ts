/**
 * P7-04: exact locations and contacts reach only the owner and the accepted runner (Backend PRD
 * 9.4, 14.2, 14.3, 17.1, INV-010). One errand with contacts and a photo, read by every kind of
 * caller at every stage.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { readyMedia } from '../test/media.helper.js';
import { acceptAssignment, addOffer, declineAssignment, getAssignment, offerScene, selectRunner } from '../test/assignment.helper.js';
import { ErrandContactService } from '../errands/errand-contact.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

const EXACT = { lat: 6.5244, lng: 3.3792 };
const PHONE_DIGITS = '8012345678';

describe('Exact data access (P7-04)', () => {
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

  /** An open errand with a pickup contact and a photo, one runner who offered, and a rival runner who offered. */
  async function scene() {
    const s = await offerScene(app, categoryId);
    const rival = await addOffer(app, s.errandId);
    await prisma.$transaction((tx) =>
      app.get(ErrandContactService).save(tx, s.errandId, 'pickup', { name: 'Ada Pickup', phone: `0${PHONE_DIGITS}` }),
    );
    const photoId = await readyMedia(app, s.requester.accessToken, 'ERRAND_PHOTO');
    await prisma.errandMedia.create({ data: { errandId: s.errandId, mediaId: photoId, position: 0 } });
    const stranger = await signedInUser(app);
    return { ...s, rival, stranger, photoId };
  }

  const mediaUrl = (user: { accessToken: string }, mediaId: string) =>
    request(app.getHttpServer()).get(`${API}/media/${mediaId}/url`).set(...bearer(user.accessToken));

  const leaks = (value: unknown): string[] => {
    const text = JSON.stringify(value);
    const found: string[] = [];
    if (text.includes(PHONE_DIGITS)) found.push('phone');
    if (text.includes('Ada Pickup')) found.push('contact name');
    if (text.includes(String(EXACT.lat))) found.push('exact lat');
    if (text.includes(String(EXACT.lng))) found.push('exact lng');
    if (text.includes('Opposite') || text.includes('addressText')) found.push('address');
    return found;
  };

  it('the marketplace never gives a runner exact data or contacts, before or after selection', async () => {
    const s = await scene();
    const detail = () => request(app.getHttpServer()).get(`${API}/marketplace/errands/${s.errandId}`).set(...bearer(s.rival.runner.accessToken));

    const before = await detail().expect(200);
    expect(leaks(before.body.data)).toEqual([]);

    await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion).expect(201);
    // Once the errand is no longer open the rival cannot see it in the marketplace at all.
    expect((await detail()).status).toBe(404);
  });

  it('pending assignment: the runner gets the approximate area and nothing else', async () => {
    const s = await scene();
    const created = (await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion).expect(201)).body.data;

    const res = await getAssignment(app, s.runner, created.id).expect(200);

    expect(res.body.data.role).toBe('RUNNER');
    expect(res.body.data.errand.accessLevel).toBe('APPROXIMATE');
    expect(res.body.data.errand.pickup.area).toBeTruthy();
    expect(res.body.data.errand.pickup.approx).toBeTruthy();
    expect(res.body.data.errand.pickup.exact).toBeUndefined();
    expect(res.body.data.errand.pickupContact).toBeNull();
    expect(res.body.data.errand.dropoffContact).toBeNull();
    expect(leaks(res.body.data)).toEqual([]);
  });

  it('the requester always sees exact locations and contacts', async () => {
    const s = await scene();
    const created = (await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion).expect(201)).body.data;

    const res = await getAssignment(app, s.requester, created.id).expect(200);

    expect(res.body.data.role).toBe('REQUESTER');
    expect(res.body.data.errand.accessLevel).toBe('EXACT');
    expect(res.body.data.errand.pickup.exact).toEqual(EXACT);
    expect(res.body.data.errand.pickupContact.phone).toContain(PHONE_DIGITS);
  });

  it('accepted assignment: the runner gets exact locations and contacts', async () => {
    const s = await scene();
    const created = (await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion).expect(201)).body.data;
    await acceptAssignment(app, s.runner, created.id).expect(201);

    const res = await getAssignment(app, s.runner, created.id).expect(200);

    expect(res.body.data.errand.accessLevel).toBe('EXACT');
    expect(res.body.data.errand.pickup.exact).toEqual(EXACT);
    expect(res.body.data.errand.pickupContact).toMatchObject({ name: 'Ada Pickup' });
    expect(res.body.data.errand.pickupContact.phone).toContain(PHONE_DIGITS);
  });

  it('exact data closes again when the assignment ends: declined, cancelled', async () => {
    const declined = await scene();
    const a = (await selectRunner(app, declined.requester, declined.errandId, declined.offerId, declined.offerVersion).expect(201)).body.data;
    await declineAssignment(app, declined.runner, a.id).expect(200);
    const afterDecline = await getAssignment(app, declined.runner, a.id).expect(200);
    expect(afterDecline.body.data.errand.accessLevel).toBe('APPROXIMATE');
    expect(leaks(afterDecline.body.data)).toEqual([]);

    const cancelled = await scene();
    const b = (await selectRunner(app, cancelled.requester, cancelled.errandId, cancelled.offerId, cancelled.offerVersion).expect(201)).body.data;
    await acceptAssignment(app, cancelled.runner, b.id).expect(201);
    await request(app.getHttpServer())
      .post(`${API}/errands/${cancelled.errandId}/cancel`)
      .set(...bearer(cancelled.requester.accessToken))
      .send({ reason: 'REQUESTER_CANCELLED' })
      .expect(200);
    const afterCancel = await getAssignment(app, cancelled.runner, b.id).expect(200);
    expect(afterCancel.body.data.errand.accessLevel).toBe('APPROXIMATE');
    expect(leaks(afterCancel.body.data)).toEqual([]);
  });

  it('the rival runner whose offer was closed and a stranger get "not found" for the assignment', async () => {
    const s = await scene();
    const created = (await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion).expect(201)).body.data;
    await acceptAssignment(app, s.runner, created.id).expect(201);

    for (const outsider of [s.rival.runner, s.stranger]) {
      const res = await getAssignment(app, outsider, created.id);
      expect(res.status).toBe(404);
      expect(leaks(res.body)).toEqual([]);
    }
  });

  describe('photos', () => {
    it('the requester and the assigned runner may fetch the errand photo; a rival runner and a stranger may not', async () => {
      const s = await scene();
      const created = (await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion).expect(201)).body.data;

      await mediaUrl(s.requester, s.photoId).expect(200);
      await mediaUrl(s.runner, s.photoId).expect(200); // pending runner: non-sensitive
      expect((await mediaUrl(s.rival.runner, s.photoId)).status).toBe(404);
      expect((await mediaUrl(s.stranger, s.photoId)).status).toBe(404);

      await acceptAssignment(app, s.runner, created.id).expect(201);
      await mediaUrl(s.runner, s.photoId).expect(200);
      expect((await mediaUrl(s.rival.runner, s.photoId)).status).toBe(404);
    });
  });

  it('no cross-account leak when the same runner holds a second, unrelated errand', async () => {
    const s = await scene();
    const created = (await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion).expect(201)).body.data;
    await acceptAssignment(app, s.runner, created.id).expect(201);
    const other = await scene();
    const otherAssignment = (await selectRunner(app, other.requester, other.errandId, other.offerId, other.offerVersion).expect(201)).body.data;

    // The first runner is neither party nor assigned on the other errand.
    expect((await getAssignment(app, s.runner, otherAssignment.id)).status).toBe(404);
    expect((await mediaUrl(s.runner, other.photoId)).status).toBe(404);
  });
});

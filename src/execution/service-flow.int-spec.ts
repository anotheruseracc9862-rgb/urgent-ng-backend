/**
 * Service flow: an errand in a SERVICE category is work done at one address. It has no pickup,
 * the same steps carry other meanings (pickup = work started, deliver = work finished) and each of
 * those steps needs a photo. HTTP only, real PostgreSQL and Redis.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { createDraft, draftBody, LAGOS_DESTINATION, publishErrand, seedCategories } from '../test/errand.helper.js';
import { readyMedia } from '../test/media.helper.js';
import { acceptedScene, completeErrand, executionStep } from '../test/assignment.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Service flow', () => {
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

  const serviceDraft = (extra: Record<string, unknown> = {}) => {
    const { pickup: _pickup, ...rest } = draftBody(ids.home_cleaning, { title: 'Clean my flat', description: 'Deep clean of a two-bedroom flat', ...extra });
    return rest;
  };

  describe('posting a service', () => {
    it('shows the flow in the public category list', async () => {
      const res = await request(app.getHttpServer()).get(`${API}/reference/categories`).expect(200);
      const flows = Object.fromEntries(res.body.data.map((c: { key: string; flow: string }) => [c.key, c.flow]));
      expect(flows).toMatchObject({ delivery: 'TRANSIT', home_cleaning: 'SERVICE' });
    });

    it('creates and publishes with one address, and the errand reports its flow', async () => {
      const user = await signedInUser(app);
      const draft = await createDraft(app, user, serviceDraft()).expect(201);
      expect(draft.body.data.category).toMatchObject({ key: 'home_cleaning', flow: 'SERVICE' });
      await publishErrand(app, user, draft.body.data.id).expect(201);
    });

    it('refuses a pickup on a service, on create and on update', async () => {
      const user = await signedInUser(app);
      const withPickup = draftBody(ids.home_cleaning, { title: 'Clean my flat', description: 'Deep clean of a two-bedroom flat' });
      const refused = await createDraft(app, user, withPickup).expect(400);
      expect(refused.body.error.details).toMatchObject({ field: 'pickup' });

      const draft = await createDraft(app, user, serviceDraft()).expect(201);
      await request(app.getHttpServer())
        .patch(`${API}/errands/${draft.body.data.id}`)
        .set(...bearer(user.accessToken))
        .send({ pickup: { point: LAGOS_DESTINATION } })
        .expect(400);
    });

    it('still asks for the address before it publishes', async () => {
      const user = await signedInUser(app);
      const { destination: _destination, ...noAddress } = serviceDraft();
      const draft = await createDraft(app, user, noAddress).expect(201);
      const res = await publishErrand(app, user, draft.body.data.id);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body.error.details)).toContain('destination');
    });
  });

  describe('doing the work', () => {
    it('start, begin with a before photo, finish with an after photo, then complete', async () => {
      const s = await acceptedScene(app, ids.home_cleaning, { locationType: 'ERRAND_DESTINATION' });

      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);

      await executionStep(app, s.runner, s.assignmentId, 'pickup').expect(400);
      const before = await readyMedia(app, s.runner.accessToken, 'PICKUP_EVIDENCE');
      const begun = await executionStep(app, s.runner, s.assignmentId, 'pickup', { mediaId: before }).expect(201);
      expect(begun.body.data).toMatchObject({ errandStatus: 'PICKED_UP' });

      const noPhoto = await executionStep(app, s.runner, s.assignmentId, 'deliver').expect(400);
      expect(noPhoto.body.error.details).toMatchObject({ field: 'mediaId' });
      const after = await readyMedia(app, s.runner.accessToken, 'DELIVERY_EVIDENCE');
      const finished = await executionStep(app, s.runner, s.assignmentId, 'deliver', { mediaId: after }).expect(201);
      expect(finished.body.data).toMatchObject({ errandStatus: 'DELIVERED' });

      await completeErrand(app, s.requester, s.errandId).expect(201);
      const row = await prisma.errand.findUniqueOrThrow({ where: { id: s.errandId } });
      expect(row.status).toBe('COMPLETED');
    });

    it('keeps photos optional on a transit errand', async () => {
      const s = await acceptedScene(app, ids.delivery);
      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
      await executionStep(app, s.runner, s.assignmentId, 'pickup').expect(201);
      await executionStep(app, s.runner, s.assignmentId, 'deliver').expect(201);
    });
  });
});

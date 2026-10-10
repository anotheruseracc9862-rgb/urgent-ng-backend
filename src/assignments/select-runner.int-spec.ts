/**
 * P7-02: selecting a runner (Backend PRD 14.2, 26.4). HTTP only, real PostgreSQL and Redis.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { insertErrand, seedCategories } from '../test/errand.helper.js';
import { offerAction } from '../test/offer.helper.js';
import { addOffer, getAssignment, offerScene, selectRunner } from '../test/assignment.helper.js';
import { BusinessConfigService } from '../config/business-config.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Select runner (P7-02)', () => {
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

  const errandStatus = async (id: string) =>
    (await prisma.$queryRaw<Array<{ status: string }>>`SELECT status::text FROM errands WHERE id = ${id}::uuid`)[0].status;

  it('creates the assignment, moves the errand and offer, closes the others, and writes history, audit and outbox', async () => {
    const s = await offerScene(app, categoryId);
    const rival = await addOffer(app, s.errandId);

    const res = await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion).expect(201);

    const assignment = res.body.data;
    expect(assignment).toMatchObject({
      errandId: s.errandId,
      offerId: s.offerId,
      requesterId: s.requester.userId,
      runnerId: s.runner.userId,
      status: 'PENDING_ACCEPTANCE',
      agreedAmountMinor: 50_000,
      currency: 'NGN',
      acceptedAt: null,
    });
    const minutes = (new Date(assignment.acceptanceDeadline).getTime() - new Date(assignment.selectedAt).getTime()) / 60_000;
    expect(minutes).toBeCloseTo(30, 1);

    expect(await errandStatus(s.errandId)).toBe('RUNNER_SELECTED');
    expect(await prisma.offer.findUniqueOrThrow({ where: { id: s.offerId } })).toMatchObject({ status: 'SELECTED', awaitingParty: 'NONE' });
    expect(await prisma.offer.findUniqueOrThrow({ where: { id: rival.offerId } })).toMatchObject({
      status: 'CLOSED',
      closeReason: 'RUNNER_SELECTED',
    });
    const history = await prisma.$queryRaw<Array<{ f: string; t: string }>>`
      SELECT from_status::text AS f, to_status::text AS t FROM errand_status_history WHERE errand_id = ${s.errandId}::uuid`;
    expect(history).toEqual([{ f: 'OPEN', t: 'RUNNER_SELECTED' }]);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'assignment.selected', aggregateId: assignment.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'assignment.selected', entityId: assignment.id } })).toBe(1);
    const types = (await prisma.negotiationEvent.findMany({ where: { offerId: s.offerId }, orderBy: { createdAt: 'asc' } })).map((e) => e.messageType);
    expect(types).toEqual(['INITIAL_OFFER', 'ACCEPT']);
  });

  it('copies the amount at selection: a later offer change never moves it', async () => {
    const s = await offerScene(app, categoryId);
    const res = await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion).expect(201);
    await prisma.$executeRaw`UPDATE offers SET amount_minor = 99999 WHERE id = ${s.offerId}::uuid`;
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(Number(row.agreedAmountMinor)).toBe(50_000);
  });

  it('uses the countered amount that was agreed', async () => {
    const s = await offerScene(app, categoryId);
    const countered = await offerAction(app, s.requester, 'post', s.offerId, 'counter', { amountMinor: 42_000, durationMinutes: 30 }).expect(200);
    const agreed = await offerAction(app, s.runner, 'post', s.offerId, 'accept-counter', { expectedVersion: countered.body.data.version }).expect(200);

    const res = await selectRunner(app, s.requester, s.errandId, s.offerId, agreed.body.data.version).expect(201);

    expect(res.body.data.agreedAmountMinor).toBe(42_000);
  });

  it('replays the first answer for the same Idempotency-Key', async () => {
    const s = await offerScene(app, categoryId);
    const key = randomUUID();
    const first = await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion, key).expect(201);
    const again = await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion, key).expect(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await prisma.assignment.count({ where: { errandId: s.errandId } })).toBe(1);
  });

  describe('refusals leave everything untouched', () => {
    const untouched = async (s: { errandId: string; offerId: string }, status = 'OPEN') => {
      expect(await prisma.assignment.count()).toBe(0);
      expect(await errandStatus(s.errandId)).toBe(status);
      expect((await prisma.offer.findUniqueOrThrow({ where: { id: s.offerId } })).status).toBe('ACTIVE');
    };

    it('a stale expectedOfferVersion: OFFER_VERSION_MISMATCH', async () => {
      const s = await offerScene(app, categoryId);
      await offerAction(app, s.runner, 'patch', s.offerId, '', { amountMinor: 45_000, durationMinutes: 30 }).expect(200);

      const res = await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('OFFER_VERSION_MISMATCH');
      await untouched(s);
    });

    it('an offer waiting on the runner: OFFER_AWAITING_RUNNER', async () => {
      const s = await offerScene(app, categoryId);
      const countered = await offerAction(app, s.requester, 'post', s.offerId, 'counter', { amountMinor: 40_000, durationMinutes: 30 }).expect(200);

      const res = await selectRunner(app, s.requester, s.errandId, s.offerId, countered.body.data.version);

      expect(res.body.error.code).toBe('OFFER_AWAITING_RUNNER');
      await untouched(s);
    });

    it('an offer flagged for reconfirmation: OFFER_NEEDS_RECONFIRMATION', async () => {
      const s = await offerScene(app, categoryId);
      await prisma.$executeRaw`
        UPDATE offers SET needs_reconfirmation = true, awaiting_party = 'REQUESTER'::"OfferAwaitingParty" WHERE id = ${s.offerId}::uuid`;
      const version = (await prisma.offer.findUniqueOrThrow({ where: { id: s.offerId } })).version;

      const res = await selectRunner(app, s.requester, s.errandId, s.offerId, version);

      expect(res.body.error.code).toBe('OFFER_NEEDS_RECONFIRMATION');
      await untouched(s);
    });

    it('a withdrawn offer: OFFER_INVALID_STATE', async () => {
      const s = await offerScene(app, categoryId);
      await offerAction(app, s.runner, 'post', s.offerId, 'withdraw').expect(200);
      const res = await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion + 1);
      expect(res.body.error.code).toBe('OFFER_INVALID_STATE');
    });

    it('someone who does not own the errand: not found', async () => {
      const s = await offerScene(app, categoryId);
      const stranger = await signedInUser(app);
      const res = await selectRunner(app, stranger, s.errandId, s.offerId, s.offerVersion);
      expect(res.status).toBe(404);
      await untouched(s);
    });

    it('the runner selecting their own offer: not found', async () => {
      const s = await offerScene(app, categoryId);
      expect((await selectRunner(app, s.runner, s.errandId, s.offerId, s.offerVersion)).status).toBe(404);
      await untouched(s);
    });

    it('an offer from another errand: not found', async () => {
      const a = await offerScene(app, categoryId);
      const other = await insertErrand({ requesterId: a.requester.userId, categoryId });
      const res = await selectRunner(app, a.requester, other, a.offerId, a.offerVersion);
      expect(res.status).toBe(404);
      await untouched(a);
    });

    it('an errand past its deadline: ERRAND_EXPIRED', async () => {
      const s = await offerScene(app, categoryId);
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() - interval '1 minute' WHERE id = ${s.errandId}::uuid`;
      const res = await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion);
      expect(res.body.error.code).toBe('ERRAND_EXPIRED');
      await untouched(s);
    });

    it('a runner who is no longer eligible: OFFER_NOT_ELIGIBLE', async () => {
      const s = await offerScene(app, categoryId);
      await request(app.getHttpServer()).put(`${API}/runner/availability`).set(...bearer(s.runner.accessToken)).send({ availability: 'UNAVAILABLE' }).expect(200);
      const res = await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('OFFER_NOT_ELIGIBLE');
      await untouched(s);
    });

    it('a cancelled errand: ERRAND_INVALID_STATE, not a conflict', async () => {
      const s = await offerScene(app, categoryId);
      await request(app.getHttpServer())
        .post(`${API}/errands/${s.errandId}/cancel`)
        .set(...bearer(s.requester.accessToken))
        .send({ reason: 'REQUESTER_CANCELLED' })
        .expect(200);
      const res = await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion + 1);
      expect(res.body.error.code).toBe('ERRAND_INVALID_STATE');
    });
  });

  describe('races', () => {
    it('two simultaneous selects of different offers create exactly one assignment; the loser gets ASSIGNMENT_CONFLICT', async () => {
      const a = await offerScene(app, categoryId);
      const b = await addOffer(app, a.errandId);

      const [first, second] = await Promise.all([
        selectRunner(app, a.requester, a.errandId, a.offerId, a.offerVersion),
        selectRunner(app, a.requester, a.errandId, b.offerId, b.offerVersion),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      const loser = first.status === 409 ? first : second;
      expect(loser.body.error.code).toBe('ASSIGNMENT_CONFLICT');
      expect(await prisma.assignment.count({ where: { errandId: a.errandId } })).toBe(1);
      const offers = await prisma.offer.findMany({ where: { errandId: a.errandId } });
      expect(offers.filter((o) => o.status === 'SELECTED')).toHaveLength(1);
      expect(offers.filter((o) => o.status === 'CLOSED')).toHaveLength(1);
    });

    it('many simultaneous selects of the same offer create one assignment', async () => {
      const s = await offerScene(app, categoryId);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion)),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await prisma.assignment.count({ where: { errandId: s.errandId } })).toBe(1);
    });

    it('select racing cancel ends consistent: either selected with nothing closed wrongly, or cancelled with every offer closed', async () => {
      const s = await offerScene(app, categoryId);

      const [pick, cancel] = await Promise.all([
        selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion),
        request(app.getHttpServer())
          .post(`${API}/errands/${s.errandId}/cancel`)
          .set(...bearer(s.requester.accessToken))
          .send({ reason: 'REQUESTER_CANCELLED' }),
      ]);

      const status = await errandStatus(s.errandId);
      const assignments = await prisma.assignment.count({ where: { errandId: s.errandId } });
      const offer = await prisma.offer.findUniqueOrThrow({ where: { id: s.offerId } });
      if (pick.status === 201) {
        // Selected first. A cancel that followed hits RUNNER_SELECTED and is allowed by the table.
        expect(assignments).toBe(1);
        expect(['RUNNER_SELECTED', 'CANCELLED']).toContain(status);
      } else {
        expect(cancel.status).toBe(200);
        expect(status).toBe('CANCELLED');
        expect(assignments).toBe(0);
        expect(offer.status).toBe('CLOSED');
      }
    });

    it('a runner already holding the maximum number of assignments cannot be selected again, even when raced across errands', async () => {
      await app.get(BusinessConfigService).set('MAX_CONCURRENT_ASSIGNMENTS_PER_RUNNER', 2);
      const requester = await signedInUser(app);
      const first = await offerScene(app, categoryId, { requester });
      const runnerId = first.runner.userId;
      const errands = await Promise.all(
        Array.from({ length: 3 }, () => insertErrand({ requesterId: requester.userId, categoryId })),
      );
      const offers: Array<{ errandId: string; offerId: string; version: number }> = [];
      for (const errandId of errands) {
        const { submitOffer } = await import('../test/offer.helper.js');
        const created = (await submitOffer(app, first.runner, errandId).expect(201)).body.data;
        offers.push({ errandId, offerId: created.id, version: created.version });
      }

      const results = await Promise.all(offers.map((o) => selectRunner(app, requester, o.errandId, o.offerId, o.version)));

      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      const refused = results.find((r) => r.status !== 201)!;
      expect(refused.status).toBe(403);
      expect(refused.body.error.details.reasons).toContain('RUNNER_AT_CAPACITY');
      expect(await prisma.assignment.count({ where: { runnerId } })).toBe(2);
    });
  });

  describe('GET /assignments/:id', () => {
    it('is visible to the requester and the runner only', async () => {
      const s = await offerScene(app, categoryId);
      const stranger = await signedInUser(app);
      const created = (await selectRunner(app, s.requester, s.errandId, s.offerId, s.offerVersion).expect(201)).body.data;

      expect((await getAssignment(app, s.requester, created.id).expect(200)).body.data.id).toBe(created.id);
      expect((await getAssignment(app, s.runner, created.id).expect(200)).body.data.id).toBe(created.id);
      expect((await getAssignment(app, stranger, created.id)).status).toBe(404);
    });
  });
});

/**
 * P7-09: change requests after acceptance (Backend PRD 15.6). HTTP only, real PostgreSQL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { insertErrand, seedCategories } from '../test/errand.helper.js';
import { readyRunner } from '../test/verification.helper.js';
import { submitOffer } from '../test/offer.helper.js';
import { acceptAssignment, acceptedScene, cancelAssignment, executionStep, selectRunner, selectedScene, uniqueNin } from '../test/assignment.helper.js';
import { ChangeRequestService } from './change-request.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Change requests (P7-09)', () => {
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

  type Authed = { accessToken: string };
  const create = (user: Authed, assignmentId: string, type: string, payload: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`${API}/assignments/${assignmentId}/change-requests`)
      .set(...bearer(user.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ type, payload });
  const respond = (user: Authed, id: string, action: 'accept' | 'reject' | 'cancel') =>
    request(app.getHttpServer())
      .post(`${API}/change-requests/${id}/${action}`)
      .set(...bearer(user.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({});
  const assignment = (id: string) => prisma.assignment.findUniqueOrThrow({ where: { id } });
  const crStatus = async (id: string) => (await prisma.changeRequest.findUniqueOrThrow({ where: { id } })).status;

  describe('create', () => {
    it('either party can propose; the request is pending with an expiry and a timeline event', async () => {
      const s = await acceptedScene(app, categoryId);

      const res = await create(s.runner, s.assignmentId, 'AMOUNT', { amountMinor: 60_000 }).expect(201);

      expect(res.body.data).toMatchObject({ type: 'AMOUNT', status: 'PENDING', requestedBy: s.runner.userId, respondedBy: null });
      const hours = (new Date(res.body.data.expiresAt).getTime() - new Date(res.body.data.createdAt).getTime()) / 3_600_000;
      expect(hours).toBeCloseTo(2, 1);
      expect(await prisma.executionEvent.count({ where: { assignmentId: s.assignmentId, type: 'CHANGE_REQUESTED' } })).toBe(1);
      expect(await prisma.outboxEvent.count({ where: { eventType: 'change_request.created' } })).toBe(1);

      const other = await acceptedScene(app, categoryId);
      await create(other.requester, other.assignmentId, 'AMOUNT', { amountMinor: 40_000 }).expect(201);
    });

    it('allows one pending request per assignment, also under a race', async () => {
      const s = await acceptedScene(app, categoryId);
      const first = await create(s.runner, s.assignmentId, 'OTHER', { note: 'gate code changed' }).expect(201);

      const second = await create(s.requester, s.assignmentId, 'AMOUNT', { amountMinor: 40_000 });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('CHANGE_REQUEST_PENDING');

      await respond(s.requester, first.body.data.id, 'reject').expect(200);
      const burst = await Promise.all([
        create(s.runner, s.assignmentId, 'OTHER', { note: 'one' }),
        create(s.requester, s.assignmentId, 'OTHER', { note: 'two' }),
        create(s.runner, s.assignmentId, 'OTHER', { note: 'three' }),
      ]);
      expect(burst.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await prisma.changeRequest.count({ where: { assignmentId: s.assignmentId, status: 'PENDING' } })).toBe(1);
    });

    it('validates the payload of each type', async () => {
      const s = await acceptedScene(app, categoryId);
      const cases: Array<[string, Record<string, unknown>]> = [
        ['AMOUNT', { amountMinor: 100 }],
        ['AMOUNT', { amountMinor: 50_000 }],
        ['AMOUNT', { amountMinor: 'lots' }],
        ['PICKUP', { point: { lat: 200, lng: 3 } }],
        ['DESTINATION', {}],
        ['TIME', { scheduledAt: 'tomorrow-ish' }],
        ['OTHER', { note: '' }],
        ['SOMETHING', {}],
      ];
      for (const [type, payload] of cases) {
        const res = await create(s.runner, s.assignmentId, type, payload);
        expect(res.status, `${type} ${JSON.stringify(payload)}`).toBe(400);
      }
      expect(await prisma.changeRequest.count()).toBe(0);
    });

    it('is refused before acceptance, after pickup and after the assignment ends', async () => {
      const pending = await selectedScene(app, categoryId);
      const early = await create(pending.runner, pending.assignmentId, 'OTHER', { note: 'x' });
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('CHANGE_REQUEST_NOT_ALLOWED');

      const s = await acceptedScene(app, categoryId);
      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
      await create(s.requester, s.assignmentId, 'OTHER', { note: 'still fine in progress' }).expect(201);
      const withPending = await prisma.changeRequest.findFirstOrThrow({ where: { assignmentId: s.assignmentId } });
      await respond(s.runner, withPending.id, 'reject').expect(200);
      await executionStep(app, s.runner, s.assignmentId, 'pickup').expect(201);
      const late = await create(s.requester, s.assignmentId, 'PICKUP', { point: { lat: 6.5, lng: 3.4 } });
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('CHANGE_REQUEST_NOT_ALLOWED');

      const ended = await acceptedScene(app, categoryId);
      await cancelAssignment(app, ended.requester, ended.assignmentId).expect(200);
      expect((await create(ended.runner, ended.assignmentId, 'OTHER', { note: 'x' })).status).toBe(409);
    });

    it('is invisible to strangers', async () => {
      const s = await acceptedScene(app, categoryId);
      const stranger = await signedInUser(app);
      expect((await create(stranger, s.assignmentId, 'OTHER', { note: 'x' })).status).toBe(404);
    });
  });

  describe('answer', () => {
    it('only the other party accepts or rejects; only the proposer cancels', async () => {
      const s = await acceptedScene(app, categoryId);
      const stranger = await signedInUser(app);
      const created = (await create(s.runner, s.assignmentId, 'OTHER', { note: 'x' }).expect(201)).body.data;

      expect((await respond(s.runner, created.id, 'accept')).status).toBe(403);
      expect((await respond(s.runner, created.id, 'reject')).status).toBe(403);
      expect((await respond(s.requester, created.id, 'cancel')).status).toBe(403);
      expect((await respond(stranger, created.id, 'accept')).status).toBe(404);

      const cancelled = await respond(s.runner, created.id, 'cancel').expect(200);
      expect(cancelled.body.data.status).toBe('CANCELLED');
      expect((await respond(s.requester, created.id, 'accept')).status).toBe(409);
    });

    it('a rejected request changes nothing', async () => {
      const s = await acceptedScene(app, categoryId);
      const created = (await create(s.runner, s.assignmentId, 'AMOUNT', { amountMinor: 70_000 }).expect(201)).body.data;

      await respond(s.requester, created.id, 'reject').expect(200);

      expect(Number((await assignment(s.assignmentId)).agreedAmountMinor)).toBe(50_000);
      expect(await crStatus(created.id)).toBe('REJECTED');
    });

    it('cannot be answered twice', async () => {
      const s = await acceptedScene(app, categoryId);
      const created = (await create(s.runner, s.assignmentId, 'OTHER', { note: 'x' }).expect(201)).body.data;
      await respond(s.requester, created.id, 'accept').expect(200);
      expect((await respond(s.requester, created.id, 'accept')).status).toBe(409);
      expect((await respond(s.requester, created.id, 'reject')).status).toBe(409);
    });
  });

  describe('accepted AMOUNT change', () => {
    it('updates the assignment, the offer and the agreement, clears both confirmations and writes the history', async () => {
      const s = await acceptedScene(app, categoryId);
      for (const user of [s.requester, s.runner]) {
        await request(app.getHttpServer())
          .put(`${API}/assignments/${s.assignmentId}/payment-agreement`)
          .set(...bearer(user.accessToken))
          .send({ paymentMethod: 'CASH', paymentTiming: 'AT_DELIVERY', confirm: true })
          .expect(200);
      }
      const created = (await create(s.runner, s.assignmentId, 'AMOUNT', { amountMinor: 65_000 }).expect(201)).body.data;

      const res = await respond(s.requester, created.id, 'accept').expect(200);

      expect(res.body.data).toMatchObject({ status: 'ACCEPTED', respondedBy: s.requester.userId });
      expect(Number((await assignment(s.assignmentId)).agreedAmountMinor)).toBe(65_000);
      const agreement = await prisma.paymentAgreement.findUniqueOrThrow({ where: { assignmentId: s.assignmentId } });
      expect(Number(agreement.agreedAmountMinor)).toBe(65_000);
      expect(agreement.confirmedByRequesterAt).toBeNull();
      expect(agreement.confirmedByRunnerAt).toBeNull();
      expect(agreement.paymentMethod).toBe('CASH');
      const offer = await prisma.offer.findUniqueOrThrow({ where: { id: s.offerId } });
      expect(Number(offer.amountMinor)).toBe(65_000);
      const events = await prisma.negotiationEvent.findMany({ where: { offerId: s.offerId }, orderBy: { createdAt: 'asc' } });
      expect(events.slice(-2).map((e) => [e.messageType, e.actorUserId, Number(e.proposedAmountMinor)])).toEqual([
        ['COUNTER_OFFER', s.runner.userId, 65_000],
        ['ACCEPT', s.requester.userId, 65_000],
      ]);
      expect(await prisma.executionEvent.count({ where: { assignmentId: s.assignmentId, type: 'CHANGE_ACCEPTED' } })).toBe(1);
      expect(await prisma.outboxEvent.count({ where: { eventType: 'change_request.accepted' } })).toBe(1);
    });
  });

  describe('accepted location and time changes', () => {
    it('a pickup change updates the location, the approximate point, the version and keeps the old values', async () => {
      const s = await acceptedScene(app, categoryId);
      const oldExact = await prisma.$queryRaw<Array<{ lat: number; lng: number; area: string }>>`
        SELECT ST_Y(exact_point::geometry) AS lat, ST_X(exact_point::geometry) AS lng, area FROM errand_locations
        WHERE errand_id = ${s.errandId}::uuid AND type = 'ERRAND_PICKUP'::"LocationType"`;
      const before = (await prisma.$queryRaw<Array<{ version: number; material_version: number }>>`
        SELECT version, material_version FROM errands WHERE id = ${s.errandId}::uuid`)[0];
      const created = (
        await create(s.requester, s.assignmentId, 'PICKUP', {
          point: { lat: 6.6, lng: 3.35 },
          addressText: '5 Opebi Road',
          landmark: 'Opposite the bank',
        }).expect(201)
      ).body.data;

      await respond(s.runner, created.id, 'accept').expect(200);

      const now = await prisma.$queryRaw<Array<{ lat: number; lng: number; alat: number; address_text: string }>>`
        SELECT ST_Y(exact_point::geometry) AS lat, ST_X(exact_point::geometry) AS lng, ST_Y(approx_point::geometry) AS alat, address_text
        FROM errand_locations WHERE errand_id = ${s.errandId}::uuid AND type = 'ERRAND_PICKUP'::"LocationType"`;
      expect(now[0]).toMatchObject({ lat: 6.6, lng: 3.35, address_text: '5 Opebi Road' });
      expect(now[0].alat).not.toBe(6.6); // the approximate point is recomputed, never the exact one
      const after = (await prisma.$queryRaw<Array<{ version: number; material_version: number }>>`
        SELECT version, material_version FROM errands WHERE id = ${s.errandId}::uuid`)[0];
      expect(after.version).toBe(before.version + 1);
      expect(after.material_version).toBe(before.material_version + 1);
      const versions = await prisma.errandVersion.findMany({ where: { errandId: s.errandId } });
      expect(versions).toHaveLength(1);
      expect(versions[0].changedFields).toEqual(['PICKUP']);
      expect(JSON.stringify(versions[0].snapshot)).toContain(String(oldExact[0].lat));
    });

    it('a time change on a scheduled errand updates the schedule; an ASAP errand refuses it', async () => {
      const asap = await acceptedScene(app, categoryId);
      const refused = await create(asap.runner, asap.assignmentId, 'TIME', { scheduledAt: new Date(Date.now() + 5 * 3_600_000).toISOString() });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('CHANGE_REQUEST_NOT_ALLOWED');

      const requester = await signedInUser(app);
      const errandId = await insertErrand({
        requesterId: requester.userId,
        categoryId,
        timeMode: 'SCHEDULED',
        scheduledAt: new Date(Date.now() + 4 * 3_600_000),
        expiresInHours: 3,
      });
      const runner = await readyRunner(app, uniqueNin(900));
      const offer = (await submitOffer(app, runner, errandId).expect(201)).body.data;
      const selected = (await selectRunner(app, requester, errandId, offer.id, offer.version).expect(201)).body.data;
      await acceptAssignment(app, runner, selected.id).expect(201);

      const newTime = new Date(Date.now() + 6 * 3_600_000);
      const created = (await create(requester, selected.id, 'TIME', { scheduledAt: newTime.toISOString() }).expect(201)).body.data;
      await respond(runner, created.id, 'accept').expect(200);

      const row = (await prisma.$queryRaw<Array<{ scheduled_at: Date }>>`SELECT scheduled_at FROM errands WHERE id = ${errandId}::uuid`)[0];
      expect(Math.abs(row.scheduled_at.getTime() - newTime.getTime())).toBeLessThan(1000);
      expect((await prisma.errandVersion.findMany({ where: { errandId } }))[0].changedFields).toEqual(['TIME']);
    });
  });

  describe('expiry', () => {
    it('an answer after the deadline is refused and the request is expired at once', async () => {
      const s = await acceptedScene(app, categoryId);
      const created = (await create(s.runner, s.assignmentId, 'AMOUNT', { amountMinor: 60_000 }).expect(201)).body.data;
      await prisma.$executeRaw`UPDATE change_requests SET expires_at = now() - interval '1 minute' WHERE id = ${created.id}::uuid`;

      const res = await respond(s.requester, created.id, 'accept');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CHANGE_REQUEST_NOT_ALLOWED');
      expect(await crStatus(created.id)).toBe('EXPIRED');
      expect(Number((await assignment(s.assignmentId)).agreedAmountMinor)).toBe(50_000);
    });

    it('the sweeper expires due requests and leaves the rest', async () => {
      const due = await acceptedScene(app, categoryId);
      const fresh = await acceptedScene(app, categoryId);
      const a = (await create(due.runner, due.assignmentId, 'OTHER', { note: 'due' }).expect(201)).body.data;
      const b = (await create(fresh.runner, fresh.assignmentId, 'OTHER', { note: 'fresh' }).expect(201)).body.data;
      await prisma.$executeRaw`UPDATE change_requests SET expires_at = now() - interval '1 minute' WHERE id = ${a.id}::uuid`;

      const service = app.get(ChangeRequestService);
      expect(await service.expireDue()).toBe(1);
      expect(await service.expireDue()).toBe(0);

      expect(await crStatus(a.id)).toBe('EXPIRED');
      expect(await crStatus(b.id)).toBe('PENDING');
      expect(await prisma.outboxEvent.count({ where: { eventType: 'change_request.expired', aggregateId: a.id } })).toBe(1);
    });

    it('pickup expires a pending request', async () => {
      const s = await acceptedScene(app, categoryId);
      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
      const created = (await create(s.requester, s.assignmentId, 'OTHER', { note: 'wait' }).expect(201)).body.data;

      await executionStep(app, s.runner, s.assignmentId, 'pickup').expect(201);

      expect(await crStatus(created.id)).toBe('EXPIRED');
      expect((await respond(s.runner, created.id, 'accept')).status).toBe(409);
    });
  });
});

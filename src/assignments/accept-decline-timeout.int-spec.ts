/**
 * P7-03: accept, decline and acceptance timeout (Backend PRD 14.3, 14.4, 36). HTTP plus the
 * sweeper entry point, real PostgreSQL and Redis. Deadlines are database columns, so tests move
 * time by rewriting them.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { acceptAssignment, addOffer, declineAssignment, selectRunner, selectedScene } from '../test/assignment.helper.js';
import { AssignmentService } from './assignment.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Accept, decline, timeout (P7-03)', () => {
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

  const errand = async (id: string) =>
    (await prisma.$queryRaw<Array<{ status: string; expires_at: Date }>>`SELECT status::text, expires_at FROM errands WHERE id = ${id}::uuid`)[0];
  const setDeadline = (assignmentId: string, sqlOffset: string) =>
    prisma.$executeRawUnsafe(`UPDATE assignments SET acceptance_deadline = now() + interval '${sqlOffset}' WHERE id = $1::uuid`, assignmentId);
  const cancelErrand = (user: { accessToken: string }, errandId: string, body: Record<string, unknown> = { reason: 'REQUESTER_CANCELLED' }) =>
    request(app.getHttpServer()).post(`${API}/errands/${errandId}/cancel`).set(...bearer(user.accessToken)).send(body);

  describe('accept', () => {
    it('moves the assignment and errand to ACCEPTED and starts the payment agreement from the selected amount', async () => {
      const s = await selectedScene(app, categoryId);

      const res = await acceptAssignment(app, s.runner, s.assignmentId).expect(201);

      expect(res.body.data).toMatchObject({ status: 'ACCEPTED', agreedAmountMinor: 50_000 });
      expect(res.body.data.acceptedAt).toBeTruthy();
      expect((await errand(s.errandId)).status).toBe('ACCEPTED');
      const agreement = await prisma.paymentAgreement.findUniqueOrThrow({ where: { assignmentId: s.assignmentId } });
      expect(Number(agreement.agreedAmountMinor)).toBe(50_000);
      expect(agreement.confirmedByRequesterAt).toBeNull();
      expect(await prisma.outboxEvent.count({ where: { eventType: 'assignment.accepted', aggregateId: s.assignmentId } })).toBe(1);
      const history = await prisma.$queryRaw<Array<{ t: string }>>`
        SELECT to_status::text AS t FROM errand_status_history WHERE errand_id = ${s.errandId}::uuid ORDER BY created_at`;
      expect(history.map((h) => h.t)).toEqual(['RUNNER_SELECTED', 'ACCEPTED']);
    });

    it('answers "not found" to anyone who is not the selected runner', async () => {
      const s = await selectedScene(app, categoryId);
      const stranger = await signedInUser(app);
      expect((await acceptAssignment(app, s.requester, s.assignmentId)).status).toBe(404);
      expect((await acceptAssignment(app, stranger, s.assignmentId)).status).toBe(404);
      expect((await errand(s.errandId)).status).toBe('RUNNER_SELECTED');
    });

    it('refuses after the deadline and settles the timer at once: timed out, offer closed, errand reopened', async () => {
      const s = await selectedScene(app, categoryId);
      await setDeadline(s.assignmentId, '-1 minute');

      const res = await acceptAssignment(app, s.runner, s.assignmentId);

      expect(res.body.error.code).toBe('ASSIGNMENT_ACCEPTANCE_EXPIRED');
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: s.assignmentId } });
      expect(row.status).toBe('TIMED_OUT');
      expect((await errand(s.errandId)).status).toBe('OPEN');
    });

    it('treats the exact deadline as expired and a moment before as accepted', async () => {
      const early = await selectedScene(app, categoryId);
      await setDeadline(early.assignmentId, '5 seconds');
      await acceptAssignment(app, early.runner, early.assignmentId).expect(201);

      const exact = await selectedScene(app, categoryId);
      await setDeadline(exact.assignmentId, '0 seconds');
      const res = await acceptAssignment(app, exact.runner, exact.assignmentId);
      expect(res.body.error.code).toBe('ASSIGNMENT_ACCEPTANCE_EXPIRED');
    });

    it('a second accept is refused and changes nothing', async () => {
      const s = await selectedScene(app, categoryId);
      await acceptAssignment(app, s.runner, s.assignmentId).expect(201);

      const again = await acceptAssignment(app, s.runner, s.assignmentId);

      expect(again.status).toBe(409);
      expect(await prisma.paymentAgreement.count({ where: { assignmentId: s.assignmentId } })).toBe(1);
    });

    it('accepting while the requester cancels leaves one consistent outcome', async () => {
      const s = await selectedScene(app, categoryId);

      const [accept, cancel] = await Promise.all([
        acceptAssignment(app, s.runner, s.assignmentId),
        cancelErrand(s.requester, s.errandId),
      ]);

      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: s.assignmentId } });
      const status = (await errand(s.errandId)).status;
      if (accept.status === 201) {
        // Accepted first; a cancel that followed ran from ACCEPTED, which the table allows.
        expect(['ACCEPTED', 'CANCELLED']).toContain(status);
        expect(row.status).toBe(status === 'CANCELLED' ? 'CANCELLED' : 'ACCEPTED');
      } else {
        expect(cancel.status).toBe(200);
        expect(status).toBe('CANCELLED');
        expect(row.status).toBe('CANCELLED');
      }
    });
  });

  describe('decline', () => {
    it('reopens the errand with its deadline kept, closes the offer, never restores it, and lets the requester pick again', async () => {
      const s = await selectedScene(app, categoryId);
      const before = (await errand(s.errandId)).expires_at;

      const res = await declineAssignment(app, s.runner, s.assignmentId).expect(200);

      expect(res.body.data.status).toBe('DECLINED');
      const after = await errand(s.errandId);
      expect(after.status).toBe('OPEN');
      expect(after.expires_at.getTime()).toBe(before.getTime());
      const offer = await prisma.offer.findUniqueOrThrow({ where: { id: s.offerId } });
      expect(offer).toMatchObject({ status: 'CLOSED', closeReason: 'ASSIGNMENT_DECLINED' });

      // The declined offer is not restored: selecting it again is refused.
      const old = await selectRunner(app, s.requester, s.errandId, s.offerId, offer.version);
      expect(old.body.error.code).toBe('OFFER_INVALID_STATE');
      // A new offer from another runner can be selected.
      const next = await addOffer(app, s.errandId);
      await selectRunner(app, s.requester, s.errandId, next.offerId, next.offerVersion).expect(201);
    });

    it('after the errand deadline the errand ends EXPIRED', async () => {
      const s = await selectedScene(app, categoryId);
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() - interval '1 minute' WHERE id = ${s.errandId}::uuid`;

      await declineAssignment(app, s.runner, s.assignmentId).expect(200);

      expect((await errand(s.errandId)).status).toBe('EXPIRED');
    });

    it('is only for the selected runner', async () => {
      const s = await selectedScene(app, categoryId);
      expect((await declineAssignment(app, s.requester, s.assignmentId)).status).toBe(404);
    });
  });

  describe('timeout', () => {
    it('the sweeper times out a due assignment, closes the offer, reopens the errand and is idempotent', async () => {
      const s = await selectedScene(app, categoryId);
      const service = app.get(AssignmentService);
      expect(await service.expireDue()).toBe(0);
      await setDeadline(s.assignmentId, '-1 minute');

      expect(await service.expireDue()).toBe(1);
      expect(await service.expireDue()).toBe(0);

      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: s.assignmentId } });
      expect(row.status).toBe('TIMED_OUT');
      expect(row.timedOutAt).not.toBeNull();
      expect((await errand(s.errandId)).status).toBe('OPEN');
      expect(await prisma.offer.findUniqueOrThrow({ where: { id: s.offerId } })).toMatchObject({
        status: 'CLOSED',
        closeReason: 'ASSIGNMENT_ACCEPTANCE_TIMEOUT',
      });
      expect(await prisma.outboxEvent.count({ where: { eventType: 'assignment.timed_out', aggregateId: s.assignmentId } })).toBe(1);
    });

    it('does nothing to an assignment that was accepted in the meantime', async () => {
      const s = await selectedScene(app, categoryId);
      await acceptAssignment(app, s.runner, s.assignmentId).expect(201);
      await setDeadline(s.assignmentId, '-1 minute');

      expect(await app.get(AssignmentService).expireDue()).toBe(0);

      expect((await prisma.assignment.findUniqueOrThrow({ where: { id: s.assignmentId } })).status).toBe('ACCEPTED');
    });

    it('ends the errand as EXPIRED when its own deadline passed during the window', async () => {
      const s = await selectedScene(app, categoryId);
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() - interval '1 minute' WHERE id = ${s.errandId}::uuid`;
      await setDeadline(s.assignmentId, '-1 minute');

      await app.get(AssignmentService).expireDue();

      expect((await errand(s.errandId)).status).toBe('EXPIRED');
      expect((await prisma.assignment.findUniqueOrThrow({ where: { id: s.assignmentId } })).status).toBe('TIMED_OUT');
    });

    it('after a timeout the requester can select another runner', async () => {
      const s = await selectedScene(app, categoryId);
      await setDeadline(s.assignmentId, '-1 minute');
      await app.get(AssignmentService).expireDue();
      const next = await addOffer(app, s.errandId);

      const res = await selectRunner(app, s.requester, s.errandId, next.offerId, next.offerVersion);

      expect(res.status).toBe(201);
      expect(res.body.data.runnerId).toBe(next.runner.userId);
    });
  });

  describe('requester cancels while the assignment is pending', () => {
    it('cancels the assignment with the reason and stage, and closes the selected offer', async () => {
      const s = await selectedScene(app, categoryId);

      await cancelErrand(s.requester, s.errandId, { reason: 'REQUESTER_CANCELLED', note: 'changed my mind' }).expect(200);

      const row = await prisma.assignment.findUniqueOrThrow({ where: { id: s.assignmentId } });
      expect(row).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'REQUESTER_CANCELLED',
        cancelledByType: 'USER',
        cancelledBy: s.requester.userId,
        cancelledStage: 'RUNNER_SELECTED',
        cancellationNote: 'changed my mind',
      });
      expect(await prisma.offer.findUniqueOrThrow({ where: { id: s.offerId } })).toMatchObject({
        status: 'CLOSED',
        closeReason: 'ERRAND_CANCELLED',
      });
      expect(await prisma.outboxEvent.count({ where: { eventType: 'assignment.cancelled', aggregateId: s.assignmentId } })).toBe(1);
    });
  });
});

/**
 * P7-06: the cancellation matrix (Backend PRD 11.7), one test per cell. HTTP only, real
 * PostgreSQL and Redis.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import {
  acceptedScene,
  addOffer,
  cancelAssignment,
  completeErrand,
  executionStep,
  selectRunner,
  selectedScene,
} from '../test/assignment.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Cancellation matrix (P7-06)', () => {
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
    (await prisma.$queryRaw<Array<{ status: string; expires_at: Date; cancellation_reason: string | null; cancelled_by_type: string | null }>>`
      SELECT status::text, expires_at, cancellation_reason::text, cancelled_by_type::text FROM errands WHERE id = ${id}::uuid`)[0];
  const assignment = (id: string) => prisma.assignment.findUniqueOrThrow({ where: { id } });
  const cancelViaErrand = (user: { accessToken: string }, errandId: string, body: Record<string, unknown> = { reason: 'REQUESTER_CANCELLED' }) =>
    request(app.getHttpServer()).post(`${API}/errands/${errandId}/cancel`).set(...bearer(user.accessToken)).send(body);

  type Stage = 'ACCEPTED' | 'IN_PROGRESS' | 'PICKED_UP' | 'DELIVERED';
  async function atStage(stage: Stage) {
    const s = await acceptedScene(app, categoryId);
    const order: Array<'start' | 'pickup' | 'deliver'> = ['start', 'pickup', 'deliver'];
    const steps = { ACCEPTED: 0, IN_PROGRESS: 1, PICKED_UP: 2, DELIVERED: 3 }[stage];
    for (const name of order.slice(0, steps)) {
      await executionStep(app, s.runner, s.assignmentId, name).expect(201);
    }
    return s;
  }

  describe('requester', () => {
    it('ACCEPTED: errand and assignment cancelled with reason, actor and stage', async () => {
      const s = await atStage('ACCEPTED');

      const res = await cancelAssignment(app, s.requester, s.assignmentId, { reason: 'REQUESTER_CANCELLED', note: 'plans changed' }).expect(200);

      expect(res.body.data.status).toBe('CANCELLED');
      expect(await errand(s.errandId)).toMatchObject({ status: 'CANCELLED', cancellation_reason: 'REQUESTER_CANCELLED', cancelled_by_type: 'USER' });
      expect(await assignment(s.assignmentId)).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: s.requester.userId,
        cancelledByType: 'USER',
        cancelledStage: 'ACCEPTED',
        cancellationNote: 'plans changed',
      });
      const event = await prisma.outboxEvent.findFirstOrThrow({ where: { eventType: 'assignment.cancelled', aggregateId: s.assignmentId } });
      expect(event.payload).toMatchObject({ stage: 'ACCEPTED', actorType: 'REQUESTER', reason: 'REQUESTER_CANCELLED' });
    });

    it('IN_PROGRESS: allowed with a reason, recorded with its stage', async () => {
      const s = await atStage('IN_PROGRESS');
      await cancelAssignment(app, s.requester, s.assignmentId, { reason: 'SAFETY_CONCERN' }).expect(200);
      expect((await errand(s.errandId)).status).toBe('CANCELLED');
      expect((await assignment(s.assignmentId)).cancelledStage).toBe('IN_PROGRESS');
    });

    it('PICKED_UP: no plain cancel, a dispute is suggested, nothing changes', async () => {
      const s = await atStage('PICKED_UP');
      for (const res of [await cancelAssignment(app, s.requester, s.assignmentId), await cancelViaErrand(s.requester, s.errandId)]) {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('ERRAND_INVALID_STATE');
        expect(res.body.error.details.suggestedAction).toBe('OPEN_DISPUTE');
      }
      expect((await errand(s.errandId)).status).toBe('PICKED_UP');
      expect((await assignment(s.assignmentId)).status).toBe('ACCEPTED');
    });

    it('DELIVERED: not a cancellation path, complete or dispute instead', async () => {
      const s = await atStage('DELIVERED');
      const res = await cancelViaErrand(s.requester, s.errandId);
      expect(res.status).toBe(409);
      expect(res.body.error.details.suggestedAction).toBe('COMPLETE_OR_DISPUTE');
      expect((await errand(s.errandId)).status).toBe('DELIVERED');
    });

    it('COMPLETED: not cancellable', async () => {
      const s = await atStage('DELIVERED');
      await completeErrand(app, s.requester, s.errandId).expect(201);
      expect((await cancelViaErrand(s.requester, s.errandId)).status).toBe(409);
      expect((await cancelAssignment(app, s.requester, s.assignmentId)).status).toBe(409);
      expect((await errand(s.errandId)).status).toBe('COMPLETED');
    });

    it('RUNNER_SELECTED: cancels the pending assignment (covered with offers closing in P7-03)', async () => {
      const s = await selectedScene(app, categoryId);
      await cancelAssignment(app, s.requester, s.assignmentId).expect(200);
      expect(await assignment(s.assignmentId)).toMatchObject({ status: 'CANCELLED', cancelledStage: 'RUNNER_SELECTED' });
      expect((await errand(s.errandId)).status).toBe('CANCELLED');
    });

    it('uses only the requester\'s own reasons', async () => {
      const s = await atStage('ACCEPTED');
      const res = await cancelAssignment(app, s.requester, s.assignmentId, { reason: 'RUNNER_CANCELLED' });
      expect(res.status).toBe(400);
      expect((await errand(s.errandId)).status).toBe('ACCEPTED');
    });
  });

  describe('runner', () => {
    it('RUNNER_SELECTED: told to decline instead', async () => {
      const s = await selectedScene(app, categoryId);
      const res = await cancelAssignment(app, s.runner, s.assignmentId, { reason: 'RUNNER_CANCELLED' });
      expect(res.status).toBe(409);
      expect(res.body.error.details.suggestedAction).toBe('DECLINE');
      expect((await assignment(s.assignmentId)).status).toBe('PENDING_ACCEPTANCE');
    });

    it('ACCEPTED: the errand returns to OPEN with a recomputed deadline and the assignment is cancelled', async () => {
      const s = await atStage('ACCEPTED');
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() + interval '2 minutes' WHERE id = ${s.errandId}::uuid`;
      const before = (await errand(s.errandId)).expires_at;

      const res = await cancelAssignment(app, s.runner, s.assignmentId, { reason: 'RUNNER_CANCELLED', note: 'bike broke down' }).expect(200);

      expect(res.body.data.status).toBe('CANCELLED');
      const after = await errand(s.errandId);
      expect(after.status).toBe('OPEN');
      expect(after.expires_at.getTime()).toBeGreaterThan(before.getTime() + 60 * 60_000);
      expect(await assignment(s.assignmentId)).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'RUNNER_CANCELLED',
        cancelledBy: s.runner.userId,
        cancelledStage: 'ACCEPTED',
        cancellationNote: 'bike broke down',
      });
      const event = await prisma.outboxEvent.findFirstOrThrow({ where: { eventType: 'assignment.cancelled', aggregateId: s.assignmentId } });
      expect(event.payload).toMatchObject({ stage: 'ACCEPTED', actorType: 'RUNNER' });
    });

    it('ACCEPTED: the reopened errand can take a new offer and a new selection', async () => {
      const s = await atStage('ACCEPTED');
      await cancelAssignment(app, s.runner, s.assignmentId, { reason: 'RUNNER_CANCELLED' }).expect(200);
      const next = await addOffer(app, s.errandId);

      const res = await selectRunner(app, s.requester, s.errandId, next.offerId, next.offerVersion);

      expect(res.status).toBe(201);
      expect(res.body.data.runnerId).toBe(next.runner.userId);
      // The cancelled runner cannot keep working: their steps are refused.
      expect((await executionStep(app, s.runner, s.assignmentId, 'start')).status).toBe(409);
    });

    it('IN_PROGRESS: the errand is cancelled and the event carries a high severity', async () => {
      const s = await atStage('IN_PROGRESS');

      await cancelAssignment(app, s.runner, s.assignmentId, { reason: 'SAFETY_CONCERN' }).expect(200);

      expect((await errand(s.errandId)).status).toBe('CANCELLED');
      expect(await assignment(s.assignmentId)).toMatchObject({ status: 'CANCELLED', cancelledStage: 'IN_PROGRESS', cancelledByType: 'USER' });
      const statusEvent = await prisma.outboxEvent.findFirstOrThrow({ where: { eventType: 'errand.cancelled', aggregateId: s.errandId } });
      expect(statusEvent.payload).toMatchObject({ stage: 'IN_PROGRESS', severity: 'HIGH' });
    });

    it('PICKED_UP and DELIVERED: no silent abandonment, a dispute is suggested', async () => {
      for (const stage of ['PICKED_UP', 'DELIVERED'] as const) {
        const s = await atStage(stage);
        const res = await cancelAssignment(app, s.runner, s.assignmentId, { reason: 'RUNNER_CANCELLED' });
        expect(res.status, stage).toBe(409);
        expect(res.body.error.details.suggestedAction, stage).toBe('OPEN_DISPUTE');
        expect((await errand(s.errandId)).status, stage).toBe(stage);
      }
    });

    it('uses only the runner\'s own reasons', async () => {
      const s = await atStage('ACCEPTED');
      const res = await cancelAssignment(app, s.runner, s.assignmentId, { reason: 'DUPLICATE_ERRAND' });
      expect(res.status).toBe(400);
      expect((await errand(s.errandId)).status).toBe('ACCEPTED');
    });
  });

  describe('everyone else and repeats', () => {
    it('a stranger gets "not found"', async () => {
      const s = await atStage('ACCEPTED');
      const stranger = await signedInUser(app);
      expect((await cancelAssignment(app, stranger, s.assignmentId)).status).toBe(404);
    });

    it('a second cancel is refused', async () => {
      const s = await atStage('ACCEPTED');
      await cancelAssignment(app, s.requester, s.assignmentId).expect(200);
      expect((await cancelAssignment(app, s.requester, s.assignmentId)).status).toBe(409);
    });

    it('both parties cancelling at once ends in one consistent state', async () => {
      const s = await atStage('ACCEPTED');

      const [a, b] = await Promise.all([
        cancelAssignment(app, s.requester, s.assignmentId, { reason: 'REQUESTER_CANCELLED' }),
        cancelAssignment(app, s.runner, s.assignmentId, { reason: 'RUNNER_CANCELLED' }),
      ]);

      expect([a.status, b.status].filter((code) => code === 200)).toHaveLength(1);
      const row = await assignment(s.assignmentId);
      expect(row.status).toBe('CANCELLED');
      const status = (await errand(s.errandId)).status;
      expect(status).toBe(row.cancelledByType === 'USER' && row.cancelledBy === s.runner.userId ? 'OPEN' : 'CANCELLED');
    });
  });
});

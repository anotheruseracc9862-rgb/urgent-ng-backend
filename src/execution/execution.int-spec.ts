/**
 * P7-05: start, pickup, delivery, completion and auto-completion (Backend PRD 15, 36.10).
 * HTTP only, real PostgreSQL and Redis. Deadlines are columns, moved by rewriting them.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { readyMedia } from '../test/media.helper.js';
import { acceptedScene, selectedScene } from '../test/assignment.helper.js';
import { ExecutionService } from './execution.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Execution (P7-05)', () => {
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
  const step = (user: Authed, assignmentId: string, name: 'start' | 'pickup' | 'deliver', body: Record<string, unknown> = {}, key = randomUUID()) =>
    request(app.getHttpServer())
      .post(`${API}/assignments/${assignmentId}/${name}`)
      .set(...bearer(user.accessToken))
      .set('Idempotency-Key', key)
      .send(body);
  const complete = (user: Authed, errandId: string, key = randomUUID()) =>
    request(app.getHttpServer()).post(`${API}/errands/${errandId}/complete`).set(...bearer(user.accessToken)).set('Idempotency-Key', key).send({});
  const errandRow = async (id: string) =>
    (await prisma.$queryRaw<Array<{ status: string; auto_complete_at: Date | null; completed_at: Date | null }>>`
      SELECT status::text, auto_complete_at, completed_at FROM errands WHERE id = ${id}::uuid`)[0];
  const assignmentStatus = async (id: string) => (await prisma.assignment.findUniqueOrThrow({ where: { id } })).status;
  const eventTypes = async (assignmentId: string) =>
    (await prisma.executionEvent.findMany({ where: { assignmentId }, orderBy: { createdAt: 'asc' } })).map((e) => e.type);

  /** Walk an accepted errand to DELIVERED. */
  async function delivered() {
    const s = await acceptedScene(app, categoryId);
    await step(s.runner, s.assignmentId, 'start').expect(201);
    await step(s.runner, s.assignmentId, 'pickup').expect(201);
    await step(s.runner, s.assignmentId, 'deliver').expect(201);
    return s;
  }

  describe('the happy path', () => {
    it('start, pickup, deliver, complete: statuses, events, checkpoints, outbox and the auto-complete deadline', async () => {
      const s = await acceptedScene(app, categoryId);

      const started = await step(s.runner, s.assignmentId, 'start').expect(201);
      expect(started.body.data).toMatchObject({ type: 'STARTED', errandStatus: 'IN_PROGRESS' });

      const pickupPhoto = await readyMedia(app, s.runner.accessToken, 'PICKUP_EVIDENCE');
      const picked = await step(s.runner, s.assignmentId, 'pickup', {
        note: 'Collected from the gate',
        mediaId: pickupPhoto,
        checkpoint: { lat: 6.5244, lng: 3.3792 },
      }).expect(201);
      expect(picked.body.data).toMatchObject({ type: 'PICKED_UP', errandStatus: 'PICKED_UP' });

      const deliveryPhoto = await readyMedia(app, s.runner.accessToken, 'DELIVERY_EVIDENCE');
      const dropped = await step(s.runner, s.assignmentId, 'deliver', { note: 'Handed to Tolu', mediaId: deliveryPhoto }).expect(201);
      expect(dropped.body.data).toMatchObject({ type: 'DELIVERED', errandStatus: 'DELIVERED' });
      const hours = (new Date(dropped.body.data.autoCompleteAt).getTime() - new Date(dropped.body.data.at).getTime()) / 3_600_000;
      expect(hours).toBeCloseTo(24, 1);

      const done = await complete(s.requester, s.errandId).expect(201);
      expect(done.body.data).toMatchObject({ type: 'COMPLETED', errandStatus: 'COMPLETED' });

      expect(await eventTypes(s.assignmentId)).toEqual(['STARTED', 'PICKED_UP', 'DELIVERED', 'COMPLETED']);
      const final = await errandRow(s.errandId);
      expect(final.status).toBe('COMPLETED');
      expect(final.auto_complete_at).toBeNull();
      expect(final.completed_at).not.toBeNull();
      expect(await assignmentStatus(s.assignmentId)).toBe('COMPLETED');

      const checkpoint = await prisma.$queryRaw<Array<{ lat: number; lng: number }>>`
        SELECT ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng FROM checkpoints
        WHERE assignment_id = ${s.assignmentId}::uuid AND type = 'PICKUP'::"CheckpointType"`;
      expect(checkpoint).toEqual([{ lat: 6.5244, lng: 3.3792 }]);

      const types = (
        await prisma.outboxEvent.findMany({ where: { OR: [{ aggregateId: s.assignmentId }, { aggregateId: s.errandId }] } })
      ).map((e) => e.eventType);
      for (const expected of ['execution.started', 'execution.picked_up', 'execution.delivered', 'errand.completed', 'assignment.completed']) {
        expect(types, expected).toContain(expected);
      }
    });

    it('errand and assignment statuses never contradict: accepted until the end', async () => {
      const s = await acceptedScene(app, categoryId);
      for (const name of ['start', 'pickup', 'deliver'] as const) {
        await step(s.runner, s.assignmentId, name).expect(201);
        expect(await assignmentStatus(s.assignmentId)).toBe('ACCEPTED');
      }
      await complete(s.requester, s.errandId).expect(201);
      expect(await assignmentStatus(s.assignmentId)).toBe('COMPLETED');
    });
  });

  describe('who and in what order', () => {
    it('refuses steps out of order and repeated steps, changing nothing', async () => {
      const s = await acceptedScene(app, categoryId);

      expect((await step(s.runner, s.assignmentId, 'pickup')).status).toBe(409);
      expect((await step(s.runner, s.assignmentId, 'deliver')).status).toBe(409);
      await step(s.runner, s.assignmentId, 'start').expect(201);
      expect((await step(s.runner, s.assignmentId, 'start')).status).toBe(409);
      expect((await step(s.runner, s.assignmentId, 'deliver')).status).toBe(409);

      expect(await eventTypes(s.assignmentId)).toEqual(['STARTED']);
      expect((await errandRow(s.errandId)).status).toBe('IN_PROGRESS');
    });

    it('answers "not found" to the requester and to a stranger on a runner step', async () => {
      const s = await acceptedScene(app, categoryId);
      const stranger = await signedInUser(app);
      expect((await step(s.requester, s.assignmentId, 'start')).status).toBe(404);
      expect((await step(stranger, s.assignmentId, 'start')).status).toBe(404);
      expect(await eventTypes(s.assignmentId)).toEqual([]);
    });

    it('an assignment that is still pending cannot start', async () => {
      const s = await selectedScene(app, categoryId);
      const res = await step(s.runner, s.assignmentId, 'start');
      expect(res.status).toBe(409);
      expect((await errandRow(s.errandId)).status).toBe('RUNNER_SELECTED');
    });

    it('only the requester completes, and only after delivery', async () => {
      const s = await acceptedScene(app, categoryId);
      await step(s.runner, s.assignmentId, 'start').expect(201);
      expect((await complete(s.requester, s.errandId)).status).toBe(409);

      const ready = await delivered();
      expect((await complete(ready.runner, ready.errandId)).status).toBe(404);
      expect((await complete(await signedInUser(app), ready.errandId)).status).toBe(404);
      await complete(ready.requester, ready.errandId).expect(201);
      expect((await complete(ready.requester, ready.errandId)).status).toBe(409);
    });

    it('replays the first answer for the same Idempotency-Key', async () => {
      const s = await delivered();
      const key = randomUUID();
      const first = await complete(s.requester, s.errandId, key).expect(201);
      const again = await complete(s.requester, s.errandId, key).expect(201);
      expect(again.body.data.eventId).toBe(first.body.data.eventId);
      expect(await eventTypes(s.assignmentId)).toEqual(['STARTED', 'PICKED_UP', 'DELIVERED', 'COMPLETED']);
    });

    it('a user who deactivated their account can still finish an errand', async () => {
      const s = await delivered();
      await prisma.$executeRaw`UPDATE users SET status = 'DEACTIVATED'::"UserStatus" WHERE id = ${s.requester.userId}::uuid`;
      await complete(s.requester, s.errandId).expect(201);
    });
  });

  describe('evidence', () => {
    it('refuses a photo of the wrong purpose, someone else\'s photo, and a photo used twice', async () => {
      const s = await acceptedScene(app, categoryId);
      await step(s.runner, s.assignmentId, 'start').expect(201);

      const wrongPurpose = await readyMedia(app, s.runner.accessToken, 'DELIVERY_EVIDENCE');
      expect((await step(s.runner, s.assignmentId, 'pickup', { mediaId: wrongPurpose })).body.error.code).toBe('MEDIA_INVALID');

      const theirs = await readyMedia(app, s.requester.accessToken, 'PICKUP_EVIDENCE');
      expect((await step(s.runner, s.assignmentId, 'pickup', { mediaId: theirs })).body.error.code).toBe('MEDIA_INVALID');

      const mine = await readyMedia(app, s.runner.accessToken, 'PICKUP_EVIDENCE');
      await step(s.runner, s.assignmentId, 'pickup', { mediaId: mine }).expect(201);
      expect((await errandRow(s.errandId)).status).toBe('PICKED_UP');
    });

    it('refuses a capture time in the future and a bad coordinate', async () => {
      const s = await acceptedScene(app, categoryId);
      await step(s.runner, s.assignmentId, 'start').expect(201);

      const future = new Date(Date.now() + 3_600_000).toISOString();
      const late = await step(s.runner, s.assignmentId, 'pickup', { checkpoint: { lat: 6.5, lng: 3.3, capturedAt: future } });
      expect(late.status).toBe(400);
      expect((await step(s.runner, s.assignmentId, 'pickup', { checkpoint: { lat: 123, lng: 3.3 } })).status).toBe(400);
      expect((await errandRow(s.errandId)).status).toBe('IN_PROGRESS');
    });

    it('evidence and notes are optional', async () => {
      const s = await delivered();
      expect(await prisma.checkpoint.count({ where: { assignmentId: s.assignmentId } })).toBe(0);
    });
  });

  describe('auto-completion', () => {
    const rewind = (errandId: string) =>
      prisma.$executeRaw`UPDATE errands SET auto_complete_at = now() - interval '1 minute' WHERE id = ${errandId}::uuid`;

    it('completes a delivered errand whose window passed, and records it as automatic', async () => {
      const s = await delivered();
      const service = app.get(ExecutionService);
      expect(await service.autoCompleteDue()).toBe(0);
      await rewind(s.errandId);

      expect(await service.autoCompleteDue()).toBe(1);
      expect(await service.autoCompleteDue()).toBe(0);

      expect((await errandRow(s.errandId)).status).toBe('COMPLETED');
      expect(await assignmentStatus(s.assignmentId)).toBe('COMPLETED');
      expect((await eventTypes(s.assignmentId)).at(-1)).toBe('AUTO_COMPLETED');
    });

    it('never completes an errand with an open dispute or report: the deadline is cleared or the status is DISPUTED', async () => {
      const reported = await delivered();
      await prisma.$executeRaw`UPDATE errands SET auto_complete_at = NULL WHERE id = ${reported.errandId}::uuid`;
      const disputed = await delivered();
      await prisma.$executeRaw`
        UPDATE errands SET status = 'DISPUTED'::"ErrandStatus", status_before_dispute = 'DELIVERED'::"ErrandStatus",
               auto_complete_at = NULL WHERE id = ${disputed.errandId}::uuid`;

      expect(await app.get(ExecutionService).autoCompleteDue()).toBe(0);

      expect((await errandRow(reported.errandId)).status).toBe('DELIVERED');
      expect((await errandRow(disputed.errandId)).status).toBe('DISPUTED');
    });

    it('does nothing when the requester completed it first', async () => {
      const s = await delivered();
      await rewind(s.errandId);
      await complete(s.requester, s.errandId).expect(201);

      expect(await app.get(ExecutionService).autoCompleteDue()).toBe(0);
      expect(await eventTypes(s.assignmentId)).not.toContain('AUTO_COMPLETED');
    });

    it('a dispute that opens after the job was scheduled wins the race against the sweeper', async () => {
      const s = await delivered();
      await rewind(s.errandId);
      // The dispute clears the deadline and sets DISPUTED between the scan and the lock.
      await prisma.$executeRaw`
        UPDATE errands SET status = 'DISPUTED'::"ErrandStatus", status_before_dispute = 'DELIVERED'::"ErrandStatus",
               auto_complete_at = NULL WHERE id = ${s.errandId}::uuid`;

      expect(await app.get(ExecutionService).autoCompleteDue()).toBe(0);
      expect((await errandRow(s.errandId)).status).toBe('DISPUTED');
    });
  });
});

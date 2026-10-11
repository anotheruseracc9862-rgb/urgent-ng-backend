/**
 * P9-02: reliability events and no-show reports (Backend PRD 21.1). Facts are written from real
 * marketplace events through the outbox; points are derived from them. HTTP, real PostgreSQL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import {
  acceptedScene,
  cancelAssignment,
  completedScene,
  declineAssignment,
  executionStep,
  selectedScene,
} from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { AssignmentService } from '../assignments/assignment.service.js';
import { EventDispatcher } from '../queue/event-dispatcher.js';
import { NoShowService } from './no-show.service.js';
import { ReliabilityService } from './reliability.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Reliability (P9-02)', () => {
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

  type Authed = { accessToken: string; userId: string };
  const events = (userId: string) =>
    prisma.reliabilityEvent.findMany({ where: { userId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  const typesOf = async (userId: string) => (await events(userId)).map((e) => `${e.eventType}:${e.severity}`);
  const points = (userId: string) => app.get(ReliabilityService).windowPoints(prisma, userId);
  const flush = () => dispatchOutbox(app);

  describe('facts from marketplace events', () => {
    it('records the runner path as neutral facts and completion for both parties', async () => {
      const s = await completedScene(app, categoryId);

      await flush();

      expect(await typesOf(s.runner.userId)).toEqual([
        'OFFER_SUBMITTED:0',
        'ASSIGNMENT_ACCEPTED:0',
        'EXECUTION_STARTED:0',
        'PICKUP_CONFIRMED:0',
        'DELIVERY_CONFIRMED:0',
        'ERRAND_COMPLETED:0',
      ]);
      expect(await typesOf(s.requester.userId)).toEqual(['ERRAND_COMPLETED:0']);
      expect(await points(s.runner.userId)).toBe(0);
    });

    it('a decline costs one point and a timeout costs one point', async () => {
      const declined = await selectedScene(app, categoryId);
      await declineAssignment(app, declined.runner, declined.assignmentId).expect(200);
      const timedOut = await selectedScene(app, categoryId);
      await prisma.$executeRaw`UPDATE assignments SET acceptance_deadline = now() - interval '1 minute' WHERE id = ${timedOut.assignmentId}::uuid`;
      await app.get(AssignmentService).expireDue();

      await flush();

      expect(await typesOf(declined.runner.userId)).toContain('ASSIGNMENT_DECLINED:1');
      expect(await typesOf(timedOut.runner.userId)).toContain('ASSIGNMENT_TIMEOUT:1');
      expect(await points(declined.runner.userId)).toBe(1);
      expect(await points(timedOut.runner.userId)).toBe(1);
    });

    it('weighs a cancellation by stage, against the party who cancelled', async () => {
      const early = await acceptedScene(app, categoryId);
      await cancelAssignment(app, early.requester, early.assignmentId, { reason: 'REQUESTER_CANCELLED' }).expect(200);
      const midway = await acceptedScene(app, categoryId);
      await executionStep(app, midway.runner, midway.assignmentId, 'start').expect(201);
      await cancelAssignment(app, midway.runner, midway.assignmentId, { reason: 'SAFETY_CONCERN' }).expect(200);
      const reopened = await acceptedScene(app, categoryId);
      await cancelAssignment(app, reopened.runner, reopened.assignmentId, { reason: 'RUNNER_CANCELLED' }).expect(200);

      await flush();

      expect(await typesOf(early.requester.userId)).toContain('ASSIGNMENT_CANCELLED:1');
      expect(await typesOf(early.runner.userId)).not.toContain('ASSIGNMENT_CANCELLED:1');
      expect(await typesOf(midway.runner.userId)).toContain('ASSIGNMENT_CANCELLED:2');
      expect(await typesOf(reopened.runner.userId)).toContain('ASSIGNMENT_CANCELLED:1');
      expect(await points(early.requester.userId)).toBe(1);
      expect(await points(midway.runner.userId)).toBe(2);
    });

    it('a requester cancelling close to a scheduled start is a late cancellation', async () => {
      const s = await acceptedScene(app, categoryId);
      await prisma.$executeRaw`
        UPDATE errands SET time_mode = 'SCHEDULED'::"TimeMode", priority = 'STANDARD'::"ErrandPriority",
                           scheduled_at = now() + interval '30 minutes'
        WHERE id = ${s.errandId}::uuid`;
      await cancelAssignment(app, s.requester, s.assignmentId, { reason: 'REQUESTER_CANCELLED' }).expect(200);

      await flush();

      expect(await typesOf(s.requester.userId)).toContain('LATE_CANCELLATION:2');
    });

    it('an admin or system cancellation is nobody\'s fault', async () => {
      const s = await acceptedScene(app, categoryId);
      await prisma.outboxEvent.create({
        data: {
          eventType: 'assignment.cancelled',
          aggregateType: 'assignment',
          aggregateId: s.assignmentId,
          payload: {
            assignmentId: s.assignmentId,
            errandId: s.errandId,
            requesterId: s.requester.userId,
            runnerId: s.runner.userId,
            actorType: 'ADMIN',
            stage: 'IN_PROGRESS',
          },
        },
      });

      await flush();

      expect(await typesOf(s.runner.userId)).not.toContain('ASSIGNMENT_CANCELLED:2');
      expect(await points(s.runner.userId)).toBe(0);
    });

    it('delivering the same event twice writes each fact once', async () => {
      const s = await acceptedScene(app, categoryId);
      await cancelAssignment(app, s.requester, s.assignmentId, { reason: 'REQUESTER_CANCELLED' }).expect(200);
      const rows = await prisma.outboxEvent.findMany();
      const dispatcher = app.get(EventDispatcher);
      const deliver = async () => {
        for (const row of rows) {
          await dispatcher.dispatch({
            eventId: row.id,
            eventType: row.eventType,
            aggregateType: row.aggregateType,
            aggregateId: row.aggregateId,
            payload: row.payload as Record<string, unknown>,
            occurredAt: row.occurredAt,
          });
        }
      };

      await deliver();
      const first = await prisma.reliabilityEvent.count();
      await deliver();

      expect(await prisma.reliabilityEvent.count()).toBe(first);
      expect(first).toBeGreaterThan(0);
    });
  });

  describe('points and explanation', () => {
    it('counts only the rolling window, and the same events always give the same result', async () => {
      const s = await acceptedScene(app, categoryId);
      const service = app.get(ReliabilityService);
      const table = await service.pointsTable();
      await prisma.$transaction(async (tx) => {
        await service.record(tx, { userId: s.runner.userId, type: 'NO_SHOW', points: table.HIGH, source: 'ADMIN', dedupeKey: 'test:recent' });
        await service.record(tx, {
          userId: s.runner.userId,
          type: 'ASSIGNMENT_TIMEOUT',
          points: table.LOW,
          source: 'SYSTEM',
          occurredAt: new Date(Date.now() - 91 * 86_400_000),
          dedupeKey: 'test:old',
        });
        await service.record(tx, { userId: s.runner.userId, type: 'ERRAND_COMPLETED', points: 0, source: 'SYSTEM', dedupeKey: 'test:positive' });
      });

      expect(await points(s.runner.userId)).toBe(4);
      expect(await points(s.runner.userId)).toBe(4);
      const explanation = await service.explain(s.runner.userId);
      expect(explanation).toMatchObject({ windowDays: 90, points: 4, reached: 'WARNING' });
      expect(explanation.events).toHaveLength(1);
      expect(explanation.events[0]).toMatchObject({ type: 'NO_SHOW', points: 4, source: 'ADMIN' });
    });

    it('lists every contributing event for the user, and only theirs', async () => {
      const s = await acceptedScene(app, categoryId);
      await cancelAssignment(app, s.requester, s.assignmentId, { reason: 'REQUESTER_CANCELLED' }).expect(200);
      await flush();

      const res = await request(app.getHttpServer()).get(`${API}/me/reliability`).set(...bearer(s.requester.accessToken)).expect(200);

      expect(res.body.data.points).toBe(1);
      expect(res.body.data.events).toHaveLength(1);
      expect(res.body.data.events[0]).toMatchObject({ type: 'ASSIGNMENT_CANCELLED', points: 1, assignmentId: s.assignmentId });
      const other = await request(app.getHttpServer()).get(`${API}/me/reliability`).set(...bearer(s.runner.accessToken)).expect(200);
      expect(other.body.data.points).toBe(0);
    });

    it('a recorded fact with points raises an event for the enforcement ladder', async () => {
      const s = await acceptedScene(app, categoryId);
      await cancelAssignment(app, s.runner, s.assignmentId, { reason: 'RUNNER_CANCELLED' }).expect(200);

      await flush();

      const raised = await prisma.outboxEvent.findMany({ where: { eventType: 'reliability.recorded' } });
      expect(raised).toHaveLength(1);
      expect(raised[0].payload).toMatchObject({ userId: s.runner.userId, eventType: 'ASSIGNMENT_CANCELLED', points: 1 });
    });

    it('facts cannot be changed or removed', async () => {
      const s = await completedScene(app, categoryId);
      await flush();
      const row = await prisma.reliabilityEvent.findFirstOrThrow({ where: { userId: s.runner.userId } });

      await expect(prisma.$executeRaw`UPDATE reliability_events SET severity = 9 WHERE id = ${row.id}::uuid`).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM reliability_events WHERE id = ${row.id}::uuid`).rejects.toThrow();
    });
  });

  describe('no-show reports', () => {
    const report = (user: Authed, assignmentId: string, body: Record<string, unknown> = {}, key = randomUUID()) =>
      request(app.getHttpServer())
        .post(`${API}/assignments/${assignmentId}/no-show`)
        .set(...bearer(user.accessToken))
        .set('Idempotency-Key', key)
        .send(body);
    const respond = (user: Authed, assignmentId: string, response: string) =>
      request(app.getHttpServer())
        .post(`${API}/assignments/${assignmentId}/no-show/respond`)
        .set(...bearer(user.accessToken))
        .send({ response });
    const state = (user: Authed, assignmentId: string) =>
      request(app.getHttpServer()).get(`${API}/assignments/${assignmentId}/no-show`).set(...bearer(user.accessToken));
    const agreedMinutesAgo = (assignmentId: string, minutes: number) =>
      prisma.$executeRawUnsafe(`UPDATE assignments SET accepted_at = now() - interval '${minutes} minutes' WHERE id = $1::uuid`, assignmentId);

    it('is refused before 30 minutes past the agreed time, with the earliest time', async () => {
      const s = await acceptedScene(app, categoryId);
      await agreedMinutesAgo(s.assignmentId, 10);

      const res = await report(s.requester, s.assignmentId);

      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('TOO_EARLY');
      const before = (await state(s.requester, s.assignmentId).expect(200)).body.data;
      expect(before).toMatchObject({ canReport: false, report: null });
      expect(before.earliestReportAt).toBeTruthy();
    });

    it('an acknowledged report confirms the no-show with high severity', async () => {
      const s = await acceptedScene(app, categoryId);
      await agreedMinutesAgo(s.assignmentId, 31);

      const created = await report(s.requester, s.assignmentId, { note: 'Waited at the shop' }).expect(201);
      expect(created.body.data).toMatchObject({ status: 'PENDING', reportedByMe: true });
      expect((await report(s.requester, s.assignmentId)).status).toBe(409);
      // Only the person reported can answer.
      expect((await respond(s.requester, s.assignmentId, 'ACKNOWLEDGE')).status).toBe(404);

      const answered = await respond(s.runner, s.assignmentId, 'ACKNOWLEDGE').expect(200);

      expect(answered.body.data).toMatchObject({ status: 'CONFIRMED', resolutionSource: 'ACKNOWLEDGED', reportedByMe: false });
      expect(await typesOf(s.runner.userId)).toContain('NO_SHOW:4');
      expect(await points(s.runner.userId)).toBe(4);
      expect(await prisma.executionEvent.count({ where: { assignmentId: s.assignmentId, type: 'NO_SHOW_REPORTED' } })).toBe(1);
    });

    it('no answer in the prompt window confirms it, once', async () => {
      const s = await acceptedScene(app, categoryId);
      await agreedMinutesAgo(s.assignmentId, 45);
      await report(s.runner, s.assignmentId).expect(201);
      const service = app.get(NoShowService);

      expect(await service.confirmDue()).toBe(0);
      await prisma.$executeRaw`UPDATE no_show_reports SET response_due_at = now() - interval '1 minute' WHERE assignment_id = ${s.assignmentId}::uuid`;
      expect(await service.confirmDue()).toBe(1);
      expect(await service.confirmDue()).toBe(0);

      const row = await prisma.noShowReport.findFirstOrThrow({ where: { assignmentId: s.assignmentId } });
      expect(row).toMatchObject({ status: 'CONFIRMED', resolutionSource: 'NO_RESPONSE' });
      expect(await typesOf(s.requester.userId)).toContain('NO_SHOW:4');
    });

    it('a late answer is settled as no answer', async () => {
      const s = await acceptedScene(app, categoryId);
      await agreedMinutesAgo(s.assignmentId, 45);
      await report(s.requester, s.assignmentId).expect(201);
      await prisma.$executeRaw`UPDATE no_show_reports SET response_due_at = now() - interval '1 minute' WHERE assignment_id = ${s.assignmentId}::uuid`;

      const res = await respond(s.runner, s.assignmentId, 'PRESENT').expect(200);

      expect(res.body.data).toMatchObject({ status: 'CONFIRMED', resolutionSource: 'NO_RESPONSE' });
    });

    it('"present" contests the report for an admin, who can confirm or dismiss it', async () => {
      const first = await acceptedScene(app, categoryId);
      const second = await acceptedScene(app, categoryId);
      for (const s of [first, second]) {
        await agreedMinutesAgo(s.assignmentId, 40);
        await report(s.requester, s.assignmentId).expect(201);
        expect((await respond(s.runner, s.assignmentId, 'PRESENT').expect(200)).body.data.status).toBe('CONTESTED');
      }
      expect(await prisma.noShowReport.count({ where: { status: 'CONTESTED' } })).toBe(2);
      const adminId = await createAdmin();
      const service = app.get(NoShowService);
      const rows = await prisma.noShowReport.findMany({ orderBy: { createdAt: 'asc' } });

      const confirmed = await service.adminResolve(rows[0].id, 'CONFIRM', { adminId }, 'Chat shows no contact');
      const dismissed = await service.adminResolve(rows[1].id, 'DISMISS', { adminId }, 'Runner was on site');

      expect(confirmed).toMatchObject({ status: 'CONFIRMED', resolutionSource: 'ADMIN', resolvedBy: adminId });
      expect(dismissed).toMatchObject({ status: 'DISMISSED', resolutionSource: 'ADMIN' });
      expect(await typesOf(first.runner.userId)).toContain('NO_SHOW:4');
      expect(await typesOf(second.runner.userId)).not.toContain('NO_SHOW:4');
      await expect(service.adminResolve(rows[0].id, 'DISMISS', { adminId }, 'again')).rejects.toMatchObject({ code: 'ASSIGNMENT_INVALID_STATE' });
    });

    it('the person left waiting cancels without a penalty after a confirmed no-show', async () => {
      const s = await acceptedScene(app, categoryId);
      await agreedMinutesAgo(s.assignmentId, 40);
      await report(s.requester, s.assignmentId).expect(201);
      await respond(s.runner, s.assignmentId, 'ACKNOWLEDGE').expect(200);

      await cancelAssignment(app, s.requester, s.assignmentId, { reason: 'REQUESTER_CANCELLED' }).expect(200);
      await flush();

      const mine = await prisma.reliabilityEvent.findFirstOrThrow({ where: { userId: s.requester.userId, eventType: 'ASSIGNMENT_CANCELLED' } });
      expect(mine.severity).toBe(0);
      expect(mine.metadata).toMatchObject({ excused: 'NO_SHOW_CONFIRMED' });
      expect(await points(s.requester.userId)).toBe(0);
      expect(await points(s.runner.userId)).toBe(4);
    });

    it('is closed to strangers and to assignments that are not active', async () => {
      const s = await acceptedScene(app, categoryId);
      await agreedMinutesAgo(s.assignmentId, 40);
      const stranger = await signedInUser(app);
      expect((await report(stranger, s.assignmentId)).status).toBe(404);
      expect((await state(stranger, s.assignmentId)).status).toBe(404);

      const pending = await selectedScene(app, categoryId);
      expect((await report(pending.requester, pending.assignmentId)).status).toBe(409);
    });

    it('tells the person reported at once and the reporter the outcome', async () => {
      const s = await acceptedScene(app, categoryId);
      await agreedMinutesAgo(s.assignmentId, 40);
      await report(s.requester, s.assignmentId).expect(201);
      await flush();
      const types = async (user: Authed) =>
        ((await request(app.getHttpServer()).get(`${API}/notifications`).set(...bearer(user.accessToken)).expect(200)).body.data as Array<{ type: string }>).map((n) => n.type);

      expect(await types(s.runner)).toContain('no_show.reported');
      expect(await types(s.requester)).not.toContain('no_show.reported');
      await respond(s.runner, s.assignmentId, 'ACKNOWLEDGE').expect(200);
      await flush();
      expect(await types(s.requester)).toContain('no_show.confirmed.reporter');
      expect(await types(s.runner)).toContain('no_show.confirmed.accused');
    });
  });

  async function createAdmin(): Promise<string> {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO admins (email, display_name, password_hash, status, updated_at)
      VALUES (${`admin-${randomUUID()}@urgent.ng`}, 'Test Admin', 'x', 'ACTIVE'::"AdminStatus", now())
      RETURNING id::text`;
    return rows[0].id;
  }
});

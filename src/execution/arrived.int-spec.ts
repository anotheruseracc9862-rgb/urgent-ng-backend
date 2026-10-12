/**
 * "I arrived at pickup": an optional confirmation between start and pickup. It never changes the
 * errand status (so the state machine and the cancellation matrix are untouched).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { acceptedScene, executionStep } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Arrived at pickup', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categories: Record<string, string>;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categories = await seedCategories();
  });
  afterAll(async () => {
    await app.close();
  });

  type Authed = { accessToken: string };
  const arrive = (user: Authed, assignmentId: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(`${API}/assignments/${assignmentId}/arrived`)
      .set(...bearer(user.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const statusOf = async (errandId: string) =>
    (await prisma.$queryRaw<Array<{ status: string }>>`SELECT status::text FROM errands WHERE id = ${errandId}::uuid`)[0].status;

  it('is recorded once after the errand started, keeps the status, and the requester can see it', async () => {
    const s = await acceptedScene(app, categories.delivery);
    await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);

    const res = await arrive(s.runner, s.assignmentId, { note: 'At the gate' }).expect(201);

    expect(res.body.data).toMatchObject({ type: 'ARRIVED', note: 'At the gate', actorType: 'USER' });
    expect(await statusOf(s.errandId)).toBe('IN_PROGRESS');
    const timeline = await request(app.getHttpServer())
      .get(`${API}/assignments/${s.assignmentId}/timeline`)
      .set(...bearer(s.requester.accessToken))
      .expect(200);
    expect(timeline.body.data.map((e: { type: string }) => e.type)).toContain('ARRIVED');
  });

  it('keeps the runner location private: a checkpoint is stored but never returned', async () => {
    const s = await acceptedScene(app, categories.delivery);
    await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);

    await arrive(s.runner, s.assignmentId, { checkpoint: { lat: 6.5, lng: 3.38 } }).expect(201);

    const rows = await prisma.$queryRaw<Array<{ type: string }>>`
      SELECT type::text FROM checkpoints WHERE assignment_id = ${s.assignmentId}::uuid
    `;
    expect(rows.map((r) => r.type)).toEqual(['ARRIVED']);
    // The step still works afterwards: pickup is the next step.
    await executionStep(app, s.runner, s.assignmentId, 'pickup').expect(201);
    expect(await statusOf(s.errandId)).toBe('PICKED_UP');
  });

  it('cannot be sent twice, before start, or after pickup', async () => {
    const s = await acceptedScene(app, categories.delivery);

    await arrive(s.runner, s.assignmentId).expect(409);
    await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
    await arrive(s.runner, s.assignmentId).expect(201);
    await arrive(s.runner, s.assignmentId).expect(409);

    const t = await acceptedScene(app, categories.delivery);
    await executionStep(app, t.runner, t.assignmentId, 'start').expect(201);
    await executionStep(app, t.runner, t.assignmentId, 'pickup').expect(201);
    await arrive(t.runner, t.assignmentId).expect(409);
  });

  it('is only for the runner of the assignment', async () => {
    const s = await acceptedScene(app, categories.delivery);
    await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);

    await arrive(s.requester, s.assignmentId).expect(404);
  });

  it('tells the requester', async () => {
    const s = await acceptedScene(app, categories.delivery);
    await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
    await arrive(s.runner, s.assignmentId).expect(201);

    await dispatchOutbox(app, { eventType: 'execution.arrived' });

    const notices = await prisma.notification.findMany({ where: { userId: s.requester.userId, type: 'execution.arrived' } });
    expect(notices).toHaveLength(1);
  });
});

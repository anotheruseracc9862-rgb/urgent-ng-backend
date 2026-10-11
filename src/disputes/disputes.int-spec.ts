/**
 * P9-03: disputes (Backend PRD 21.3). Opening one moves the errand to DISPUTED through the state
 * machine, evidence keeps its source, an admin decision moves the errand on. HTTP, real PostgreSQL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { acceptedScene, executionStep, selectedScene } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { readyMedia } from '../test/media.helper.js';
import { ExecutionService } from '../execution/execution.service.js';
import { DisputeService } from './dispute.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Disputes (P9-03)', () => {
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
  const open = (user: Authed, assignmentId: string, body: Record<string, unknown> = {}, key = randomUUID()) =>
    request(app.getHttpServer())
      .post(`${API}/assignments/${assignmentId}/disputes`)
      .set(...bearer(user.accessToken))
      .set('Idempotency-Key', key)
      .send({ type: 'ITEM_NOT_DELIVERED', claim: 'The item never arrived.', ...body });
  const view = (user: Authed, disputeId: string) =>
    request(app.getHttpServer()).get(`${API}/disputes/${disputeId}`).set(...bearer(user.accessToken));
  const addEvidence = (user: Authed, disputeId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`${API}/disputes/${disputeId}/evidence`).set(...bearer(user.accessToken)).send(body);
  const errandRow = async (id: string) =>
    (
      await prisma.$queryRaw<Array<{ status: string; status_before_dispute: string | null; auto_complete_at: Date | null }>>`
        SELECT status::text, status_before_dispute::text, auto_complete_at FROM errands WHERE id = ${id}::uuid`
    )[0];
  const adminId = async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO admins (email, display_name, password_hash, status, updated_at)
      VALUES (${`admin-${randomUUID()}@urgent.ng`}, 'Test Admin', 'x', 'ACTIVE'::"AdminStatus", now())
      RETURNING id::text`;
    return rows[0].id;
  };

  const addCheckpoint = async (assignmentId: string) => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO checkpoints (assignment_id, type, captured_at)
      VALUES (${assignmentId}::uuid, 'PICKUP'::"CheckpointType", now())
      RETURNING id::text`;
    return rows[0];
  };

  type Stage = 'ACCEPTED' | 'IN_PROGRESS' | 'PICKED_UP' | 'DELIVERED';
  async function atStage(stage: Stage) {
    const s = await acceptedScene(app, categoryId);
    const steps = { ACCEPTED: 0, IN_PROGRESS: 1, PICKED_UP: 2, DELIVERED: 3 }[stage];
    for (const name of (['start', 'pickup', 'deliver'] as const).slice(0, steps)) {
      await executionStep(app, s.runner, s.assignmentId, name).expect(201);
    }
    return s;
  }

  describe('opening', () => {
    it.each(['ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED'] as const)('moves a %s errand to DISPUTED and remembers where it was', async (stage) => {
      const s = await atStage(stage);

      const res = await open(s.requester, s.assignmentId).expect(201);

      expect(res.body.data).toMatchObject({
        status: 'OPEN',
        type: 'ITEM_NOT_DELIVERED',
        openedByMe: true,
        assignmentId: s.assignmentId,
        canAddEvidence: true,
      });
      expect(res.body.data.firstResponseDueAt).toBeTruthy();
      expect(res.body.data.resolutionDueAt).toBeTruthy();
      expect(await errandRow(s.errandId)).toMatchObject({ status: 'DISPUTED', status_before_dispute: stage, auto_complete_at: null });
      const history = await prisma.errandStatusHistory.findFirst({ where: { errandId: s.errandId, toStatus: 'DISPUTED' } });
      expect(history).not.toBeNull();
    });

    it('either party may open it, and the other sees it', async () => {
      const s = await atStage('IN_PROGRESS');
      const res = await open(s.runner, s.assignmentId, { type: 'SAFETY_INCIDENT', claim: 'I felt unsafe.' }).expect(201);

      const other = await view(s.requester, res.body.data.id).expect(200);

      expect(other.body.data).toMatchObject({ openedByMe: false, type: 'SAFETY_INCIDENT', claim: 'I felt unsafe.' });
    });

    it('is refused for a second dispute on the same assignment', async () => {
      const s = await atStage('PICKED_UP');
      await open(s.requester, s.assignmentId).expect(201);

      const again = await open(s.runner, s.assignmentId);

      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('DISPUTE_ALREADY_OPEN');
      expect(await prisma.dispute.count()).toBe(1);
    });

    it('is refused for strangers, before acceptance and on a finished errand', async () => {
      const s = await atStage('PICKED_UP');
      const stranger = await signedInUser(app);
      expect((await open(stranger, s.assignmentId)).status).toBe(404);

      const pending = await selectedScene(app, categoryId);
      const early = await open(pending.requester, pending.assignmentId);
      expect(early.status).toBe(409);
      expect(await prisma.dispute.count()).toBe(0);
    });

    it('carries evidence given with it and validates the claim', async () => {
      const s = await atStage('DELIVERED');
      expect((await open(s.requester, s.assignmentId, { claim: '' })).status).toBe(400);
      expect((await open(s.requester, s.assignmentId, { type: 'NON_PAYMENT' })).status).toBe(400);

      const res = await open(s.requester, s.assignmentId, { evidence: [{ sourceType: 'STATEMENT', statement: 'I waited two hours.' }] }).expect(201);

      expect(res.body.data.evidence).toHaveLength(1);
      expect(res.body.data.evidence[0]).toMatchObject({ sourceType: 'STATEMENT', statement: 'I waited two hours.', addedByMe: true });
    });

    it('stops execution: the runner cannot continue a disputed errand', async () => {
      const s = await atStage('IN_PROGRESS');
      await open(s.requester, s.assignmentId).expect(201);

      const res = await executionStep(app, s.runner, s.assignmentId, 'pickup');

      expect(res.status).toBe(409);
      expect((await errandRow(s.errandId)).status).toBe('DISPUTED');
    });
  });

  describe('auto-completion', () => {
    it('a dispute opened after the deadline was scheduled keeps the errand from completing', async () => {
      const s = await atStage('DELIVERED');
      await prisma.$executeRaw`UPDATE errands SET auto_complete_at = now() - interval '1 minute' WHERE id = ${s.errandId}::uuid`;
      await open(s.requester, s.assignmentId).expect(201);

      expect(await app.get(ExecutionService).autoCompleteDue()).toBe(0);

      expect((await errandRow(s.errandId)).status).toBe('DISPUTED');
    });
  });

  describe('evidence', () => {
    it('keeps the source of each item, for either party, and refuses what is not part of the errand', async () => {
      const s = await atStage('PICKED_UP');
      const dispute = (await open(s.requester, s.assignmentId).expect(201)).body.data;
      const checkpoint = await addCheckpoint(s.assignmentId);
      const event = await prisma.executionEvent.findFirstOrThrow({ where: { assignmentId: s.assignmentId } });

      await addEvidence(s.requester, dispute.id, { sourceType: 'CHECKPOINT', sourceId: checkpoint.id }).expect(201);
      await addEvidence(s.runner, dispute.id, { sourceType: 'EXECUTION_EVENT', sourceId: event.id }).expect(201);
      const withStatement = await addEvidence(s.runner, dispute.id, { sourceType: 'STATEMENT', statement: 'Customer was unreachable.' }).expect(201);

      expect(withStatement.body.data.evidence).toHaveLength(3);
      expect(withStatement.body.data.evidence.map((e: { sourceType: string; sourceId: string | null }) => [e.sourceType, e.sourceId])).toEqual([
        ['CHECKPOINT', checkpoint.id],
        ['EXECUTION_EVENT', event.id],
        ['STATEMENT', null],
      ]);
      // Another assignment's checkpoint, a random id, and a statement without text.
      const other = await atStage('PICKED_UP');
      const foreign = await addCheckpoint(other.assignmentId);
      expect((await addEvidence(s.requester, dispute.id, { sourceType: 'CHECKPOINT', sourceId: foreign.id })).status).toBe(400);
      expect((await addEvidence(s.requester, dispute.id, { sourceType: 'MESSAGE', sourceId: randomUUID() })).status).toBe(400);
      expect((await addEvidence(s.requester, dispute.id, { sourceType: 'STATEMENT' })).status).toBe(400);
      expect((await addEvidence(s.requester, dispute.id, { sourceType: 'PAYMENT_PROOF', sourceId: randomUUID() })).status).toBe(400);
    });

    it('attaches a dispute photo that the other party can then view, and a stranger cannot', async () => {
      const s = await atStage('DELIVERED');
      const dispute = (await open(s.requester, s.assignmentId).expect(201)).body.data;
      const photo = await readyMedia(app, s.requester.accessToken, 'DISPUTE_EVIDENCE');
      const stranger = await signedInUser(app);
      const url = (user: Authed) => request(app.getHttpServer()).get(`${API}/media/${photo}/url`).set(...bearer(user.accessToken));
      // Not attached yet: only the uploader.
      expect((await url(s.runner)).status).toBe(404);

      await addEvidence(s.requester, dispute.id, { sourceType: 'MEDIA', sourceId: photo }).expect(201);

      expect((await url(s.requester)).status).toBe(200);
      expect((await url(s.runner)).status).toBe(200);
      expect((await url(stranger)).status).toBe(404);
      // A file is attached once.
      expect((await addEvidence(s.requester, dispute.id, { sourceType: 'MEDIA', sourceId: photo })).status).toBe(400);
      // Someone else's file cannot be attached.
      const theirs = await readyMedia(app, s.runner.accessToken, 'DISPUTE_EVIDENCE');
      expect((await addEvidence(s.requester, dispute.id, { sourceType: 'MEDIA', sourceId: theirs })).status).toBe(400);
    });

    it('is closed to strangers, and after the dispute is decided', async () => {
      const s = await atStage('DELIVERED');
      const dispute = (await open(s.requester, s.assignmentId).expect(201)).body.data;
      const stranger = await signedInUser(app);
      expect((await view(stranger, dispute.id)).status).toBe(404);
      expect((await addEvidence(stranger, dispute.id, { sourceType: 'STATEMENT', statement: 'hi' })).status).toBe(404);

      await app.get(DisputeService).adminResolve(dispute.id, { outcome: 'DISMISS', notes: 'No case.' }, { adminId: await adminId() });

      const late = await addEvidence(s.requester, dispute.id, { sourceType: 'STATEMENT', statement: 'one more thing' });
      expect(late.status).toBe(409);
      expect((await view(s.requester, dispute.id).expect(200)).body.data.canAddEvidence).toBe(false);
    });
  });

  describe('resolution (admin)', () => {
    const resolve = (disputeId: string, outcome: 'COMPLETE' | 'CANCEL' | 'DISMISS', extra: Record<string, unknown> = {}, admin = '') =>
      app.get(DisputeService).adminResolve(disputeId, { outcome, notes: 'Reviewed the evidence.', ...extra }, { adminId: admin });

    it('COMPLETE completes the errand and its assignment', async () => {
      const s = await atStage('PICKED_UP');
      const dispute = (await open(s.requester, s.assignmentId).expect(201)).body.data;
      const admin = await adminId();

      const resolved = await resolve(dispute.id, 'COMPLETE', {}, admin);

      expect(resolved).toMatchObject({ status: 'RESOLVED', resolution: 'COMPLETE', resolvedBy: admin });
      expect((await errandRow(s.errandId)).status).toBe('COMPLETED');
      expect(await prisma.assignment.findUniqueOrThrow({ where: { id: s.assignmentId } })).toMatchObject({ status: 'COMPLETED' });
      // Ratings open once the errand is completed (Backend PRD 20.1).
      const ratings = await request(app.getHttpServer()).get(`${API}/assignments/${s.assignmentId}/ratings`).set(...bearer(s.requester.accessToken)).expect(200);
      expect(ratings.body.data.canRate).toBe(true);
    });

    it('CANCEL cancels the errand and the assignment, with the admin as actor', async () => {
      const s = await atStage('IN_PROGRESS');
      const dispute = (await open(s.runner, s.assignmentId).expect(201)).body.data;
      const admin = await adminId();

      await resolve(dispute.id, 'CANCEL', {}, admin);

      const errand = await prisma.errand.findUniqueOrThrow({ where: { id: s.errandId } });
      expect(errand).toMatchObject({ status: 'CANCELLED', cancellationReason: 'ADMIN_CANCELLED', cancelledByType: 'ADMIN' });
      expect((await prisma.assignment.findUniqueOrThrow({ where: { id: s.assignmentId } })).status).toBe('CANCELLED');
    });

    it('DISMISS returns the errand to where it was, and restarts auto-completion for a delivered one', async () => {
      const delivered = await atStage('DELIVERED');
      const inProgress = await atStage('IN_PROGRESS');
      const d1 = (await open(delivered.requester, delivered.assignmentId).expect(201)).body.data;
      const d2 = (await open(inProgress.requester, inProgress.assignmentId).expect(201)).body.data;
      const admin = await adminId();

      await resolve(d1.id, 'DISMISS', {}, admin);
      await resolve(d2.id, 'DISMISS', {}, admin);

      const first = await errandRow(delivered.errandId);
      expect(first.status).toBe('DELIVERED');
      expect(first.status_before_dispute).toBeNull();
      expect(first.auto_complete_at).not.toBeNull();
      expect(first.auto_complete_at!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
      expect((await errandRow(inProgress.errandId)).status).toBe('IN_PROGRESS');
      // The runner can carry on.
      await executionStep(app, inProgress.runner, inProgress.assignmentId, 'pickup').expect(201);
    });

    it('records DISPUTE_RESOLVED for both parties and the facts the admin chose, once', async () => {
      const s = await atStage('DELIVERED');
      const dispute = (await open(s.requester, s.assignmentId).expect(201)).body.data;
      const admin = await adminId();

      await resolve(dispute.id, 'COMPLETE', { facts: [{ userId: s.requester.userId, type: 'FALSE_NON_COMPLETION_CLAIM' }] }, admin);

      const facts = await prisma.reliabilityEvent.findMany({
        where: { eventType: { in: ['DISPUTE_RESOLVED', 'FALSE_NON_COMPLETION_CLAIM'] } },
        orderBy: { eventType: 'asc' },
      });
      expect(facts.map((f) => [f.userId === s.requester.userId ? 'requester' : 'runner', f.eventType, f.severity]).sort()).toEqual(
        [
          ['requester', 'DISPUTE_RESOLVED', 0],
          ['requester', 'FALSE_NON_COMPLETION_CLAIM', 4],
          ['runner', 'DISPUTE_RESOLVED', 0],
        ].sort(),
      );
      const audit = await prisma.auditLog.findFirst({ where: { action: 'dispute.resolved', entityId: dispute.id } });
      expect(audit).toMatchObject({ actorType: 'ADMIN', actorId: admin });
    });

    it('cannot be decided twice, and a fact must be about a party', async () => {
      const s = await atStage('DELIVERED');
      const dispute = (await open(s.requester, s.assignmentId).expect(201)).body.data;
      const admin = await adminId();
      const stranger = await signedInUser(app);

      await expect(resolve(dispute.id, 'COMPLETE', { facts: [{ userId: stranger.userId, type: 'NO_SHOW' }] }, admin)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      await resolve(dispute.id, 'COMPLETE', {}, admin);

      await expect(resolve(dispute.id, 'CANCEL', {}, admin)).rejects.toMatchObject({ code: 'ERRAND_INVALID_STATE' });
      expect((await errandRow(s.errandId)).status).toBe('COMPLETED');
    });

    it('tells the other party at opening and both at the decision, without the claim text', async () => {
      const s = await atStage('DELIVERED');
      const dispute = (await open(s.requester, s.assignmentId, { claim: 'SECRET-CLAIM-TEXT' }).expect(201)).body.data;
      await dispatchOutbox(app);
      const notices = async (user: Authed) =>
        (await request(app.getHttpServer()).get(`${API}/notifications`).set(...bearer(user.accessToken)).expect(200)).body.data as Array<{ type: string; body: string }>;

      expect((await notices(s.runner)).map((n) => n.type)).toContain('dispute.opened');
      expect((await notices(s.requester)).map((n) => n.type)).not.toContain('dispute.opened');
      await resolve(dispute.id, 'DISMISS', {}, await adminId());
      await dispatchOutbox(app);

      for (const user of [s.requester, s.runner]) {
        const resolved = (await notices(user)).filter((n) => n.type === 'dispute.resolved');
        expect(resolved, user.userId).toHaveLength(1);
        expect(resolved[0].body).not.toContain('SECRET-CLAIM-TEXT');
      }
    });
  });

  describe('account deletion', () => {
    it('is blocked while a dispute is open', async () => {
      const s = await atStage('DELIVERED');
      const dispute = (await open(s.requester, s.assignmentId).expect(201)).body.data;
      const del = (user: Authed) =>
        request(app.getHttpServer()).post(`${API}/me/delete-request`).set(...bearer(user.accessToken)).send({ reason: 'leaving' });

      const blocked = await del(s.runner);

      expect(blocked.status).toBe(409);
      expect(JSON.stringify(blocked.body.error.details)).toContain('OPEN_DISPUTE');
      await app.get(DisputeService).adminResolve(dispute.id, { outcome: 'CANCEL', notes: 'Closed.' }, { adminId: await adminId() });
      const after = await del(s.runner);
      expect(JSON.stringify(after.body)).not.toContain('OPEN_DISPUTE');
    });
  });

  describe('schema', () => {
    it('rejects a dispute opened by someone outside the assignment, and edits to evidence', async () => {
      const s = await atStage('DELIVERED');
      const stranger = await signedInUser(app);

      await expect(
        prisma.dispute.create({
          data: { errandId: s.errandId, assignmentId: s.assignmentId, openedBy: stranger.userId, type: 'OTHER', claim: 'x' },
        }),
      ).rejects.toThrow();

      const dispute = (await open(s.requester, s.assignmentId, { evidence: [{ sourceType: 'STATEMENT', statement: 'one' }] }).expect(201)).body.data;
      const item = await prisma.evidenceLink.findFirstOrThrow({ where: { disputeId: dispute.id } });
      await expect(prisma.$executeRaw`DELETE FROM evidence_links WHERE id = ${item.id}::uuid`).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM disputes WHERE id = ${dispute.id}::uuid`).rejects.toThrow();
    });
  });
});

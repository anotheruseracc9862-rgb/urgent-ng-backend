/**
 * P7-10: the core marketplace flow through the HTTP API only (milestone M3), plus the reopen
 * cycle, a timer race and the errand/assignment agreement invariant. Real PostgreSQL and Redis.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { openErrand, seedCategories } from '../test/errand.helper.js';
import { readyRunner } from '../test/verification.helper.js';
import { readyMedia } from '../test/media.helper.js';
import { listOffers, offerAction, submitOffer } from '../test/offer.helper.js';
import {
  acceptAssignment,
  addOffer,
  cancelAssignment,
  completeErrand,
  declineAssignment,
  executionStep,
  getAssignment,
  selectRunner,
  uniqueNin,
} from '../test/assignment.helper.js';
import { AssignmentService } from './assignment.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Core flow (P7-10, milestone M3)', () => {
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
  const get = (user: Authed, path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(user.accessToken));
  const errandStatus = async (id: string) =>
    (await prisma.$queryRaw<Array<{ status: string }>>`SELECT status::text FROM errands WHERE id = ${id}::uuid`)[0].status;

  /** INV-004 and PRD 11.6: an assignment never contradicts its errand. */
  async function assertAgreement(): Promise<void> {
    const bad = await prisma.$queryRaw<Array<{ assignment: string; errand: string; id: string }>>`
      SELECT a.status::text AS assignment, e.status::text AS errand, a.id::text AS id
      FROM assignments a JOIN errands e ON e.id = a.errand_id
      WHERE (a.status = 'PENDING_ACCEPTANCE' AND e.status <> 'RUNNER_SELECTED')
         OR (a.status = 'ACCEPTED' AND e.status NOT IN ('ACCEPTED','IN_PROGRESS','PICKED_UP','DELIVERED','DISPUTED'))
         OR (a.status = 'COMPLETED' AND e.status <> 'COMPLETED')
         OR (e.status IN ('RUNNER_SELECTED','ACCEPTED','IN_PROGRESS','PICKED_UP','DELIVERED')
             AND NOT EXISTS (SELECT 1 FROM assignments x WHERE x.errand_id = e.id AND x.status IN ('PENDING_ACCEPTANCE','ACCEPTED')))
    `;
    expect(bad).toEqual([]);
  }

  it('register, verify, post, discover, offer, counter, agree, select, accept, execute, complete', async () => {
    // Accounts: the requester only needs an account; the runner is OTP-verified, KYC-verified and available.
    const requester = await signedInUser(app);
    const runner = await readyRunner(app, uniqueNin(1));

    // The requester posts an errand through the API.
    const errandId = await openErrand(app, requester, categoryId);

    // The runner finds it in the feed (approximate data only).
    const feed = await get(runner, '/marketplace/errands').expect(200);
    const item = feed.body.data.find((e: { id: string }) => e.id === errandId);
    expect(item).toBeTruthy();
    expect(JSON.stringify(item)).not.toMatch(/Allen Avenue/);

    // Offer, counter, runner agrees.
    const offer = (await submitOffer(app, runner, errandId, { amountMinor: 60_000 }).expect(201)).body.data;
    expect((await listOffers(app, requester, errandId).expect(200)).body.data).toHaveLength(1);
    const countered = await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 50_000, durationMinutes: 40 }).expect(200);
    const agreed = await offerAction(app, runner, 'post', offer.id, 'accept-counter', { expectedVersion: countered.body.data.version }).expect(200);
    expect(agreed.body.data.awaitingParty).toBe('NONE');

    // Select and accept.
    const selected = await selectRunner(app, requester, errandId, offer.id, agreed.body.data.version).expect(201);
    const assignmentId = selected.body.data.id as string;
    expect(selected.body.data.agreedAmountMinor).toBe(50_000);
    expect(await errandStatus(errandId)).toBe('RUNNER_SELECTED');
    await assertAgreement();

    // Before acceptance the runner sees the area only.
    const pendingView = (await getAssignment(app, runner, assignmentId).expect(200)).body.data;
    expect(pendingView.errand.accessLevel).toBe('APPROXIMATE');
    await acceptAssignment(app, runner, assignmentId).expect(201);
    expect((await getAssignment(app, runner, assignmentId).expect(200)).body.data.errand.accessLevel).toBe('EXACT');
    await assertAgreement();

    // Agree how the fee is paid (recorded only).
    await request(app.getHttpServer())
      .put(`${API}/assignments/${assignmentId}/payment-agreement`)
      .set(...bearer(runner.accessToken))
      .send({ paymentMethod: 'CASH', paymentTiming: 'AT_DELIVERY', confirm: true })
      .expect(200);

    // Execute.
    await executionStep(app, runner, assignmentId, 'start').expect(201);
    const pickupPhoto = await readyMedia(app, runner.accessToken, 'PICKUP_EVIDENCE');
    await executionStep(app, runner, assignmentId, 'pickup', { mediaId: pickupPhoto, checkpoint: { lat: 6.5244, lng: 3.3792 } }).expect(201);
    expect(await errandStatus(errandId)).toBe('PICKED_UP');
    await executionStep(app, runner, assignmentId, 'deliver', { note: 'Left with the receptionist' }).expect(201);
    expect(await errandStatus(errandId)).toBe('DELIVERED');
    await assertAgreement();

    // Complete.
    await completeErrand(app, requester, errandId).expect(201);
    expect(await errandStatus(errandId)).toBe('COMPLETED');
    await assertAgreement();

    // The record tells the whole story.
    const negotiation = await prisma.negotiationEvent.findMany({ where: { offerId: offer.id }, orderBy: { createdAt: 'asc' } });
    expect(negotiation.map((e) => [e.messageType, Number(e.proposedAmountMinor)])).toEqual([
      ['INITIAL_OFFER', 60_000],
      ['COUNTER_OFFER', 50_000],
      ['ACCEPT', 50_000],
      ['ACCEPT', 50_000],
    ]);
    const timeline = (await get(requester, `/assignments/${assignmentId}/timeline`).expect(200)).body.data;
    expect(timeline.map((e: { type: string }) => e.type)).toEqual(['STARTED', 'PICKED_UP', 'DELIVERED', 'COMPLETED']);
    const history = await prisma.$queryRaw<Array<{ t: string }>>`
      SELECT to_status::text AS t FROM errand_status_history WHERE errand_id = ${errandId}::uuid ORDER BY created_at, id`;
    expect(history.map((h) => h.t)).toEqual(['OPEN', 'RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED', 'COMPLETED']);

    // Both sides' dashboards.
    const mine = await get(requester, '/errands/mine?tab=PAST').expect(200);
    expect(mine.body.data.map((e: { id: string }) => e.id)).toContain(errandId);
    const runs = await get(runner, '/runner/assignments?status=PAST').expect(200);
    expect(runs.body.data[0]).toMatchObject({ id: assignmentId, status: 'COMPLETED', errandStatus: 'COMPLETED' });
  });

  it('a reopen cycle: decline, timeout, runner cancel, then success, with consistent statuses throughout', async () => {
    const requester = await signedInUser(app);
    const errandId = await openErrand(app, requester, categoryId);
    const service = app.get(AssignmentService);
    const rewind = (id: string) => prisma.$executeRaw`UPDATE assignments SET acceptance_deadline = now() - interval '1 minute' WHERE id = ${id}::uuid`;

    // Runner A declines.
    const a = await addOffer(app, errandId);
    const selectedA = (await selectRunner(app, requester, errandId, a.offerId, a.offerVersion).expect(201)).body.data;
    await declineAssignment(app, a.runner, selectedA.id).expect(200);
    expect(await errandStatus(errandId)).toBe('OPEN');
    await assertAgreement();

    // Runner B lets the window pass.
    const b = await addOffer(app, errandId);
    const selectedB = (await selectRunner(app, requester, errandId, b.offerId, b.offerVersion).expect(201)).body.data;
    await rewind(selectedB.id);
    expect(await service.expireDue()).toBe(1);
    expect(await errandStatus(errandId)).toBe('OPEN');
    await assertAgreement();

    // Runner C accepts, then cancels before starting: the errand reopens.
    const c = await addOffer(app, errandId);
    const selectedC = (await selectRunner(app, requester, errandId, c.offerId, c.offerVersion).expect(201)).body.data;
    await acceptAssignment(app, c.runner, selectedC.id).expect(201);
    await cancelAssignment(app, c.runner, selectedC.id, { reason: 'RUNNER_CANCELLED' }).expect(200);
    expect(await errandStatus(errandId)).toBe('OPEN');
    await assertAgreement();

    // Runner D finishes the job.
    const d = await addOffer(app, errandId);
    const selectedD = (await selectRunner(app, requester, errandId, d.offerId, d.offerVersion).expect(201)).body.data;
    await acceptAssignment(app, d.runner, selectedD.id).expect(201);
    for (const name of ['start', 'pickup', 'deliver'] as const) {
      await executionStep(app, d.runner, selectedD.id, name).expect(201);
    }
    await completeErrand(app, requester, errandId).expect(201);

    const statuses = (await prisma.assignment.findMany({ where: { errandId }, orderBy: { createdAt: 'asc' } })).map((x) => x.status);
    expect(statuses).toEqual(['DECLINED', 'TIMED_OUT', 'CANCELLED', 'COMPLETED']);
    await assertAgreement();
  });

  it('an accept racing the timeout sweeper at the deadline ends in exactly one outcome', async () => {
    const requester = await signedInUser(app);
    const errandId = await openErrand(app, requester, categoryId);
    const a = await addOffer(app, errandId);
    const selected = (await selectRunner(app, requester, errandId, a.offerId, a.offerVersion).expect(201)).body.data;
    await prisma.$executeRaw`UPDATE assignments SET acceptance_deadline = now() + interval '150 milliseconds' WHERE id = ${selected.id}::uuid`;

    const [accept] = await Promise.all([
      acceptAssignment(app, a.runner, selected.id),
      new Promise((resolve) => setTimeout(resolve, 200)).then(() => app.get(AssignmentService).expireDue()),
    ]);

    const row = await prisma.assignment.findUniqueOrThrow({ where: { id: selected.id } });
    if (accept.status === 201) {
      expect(row.status).toBe('ACCEPTED');
      expect(await errandStatus(errandId)).toBe('ACCEPTED');
    } else {
      expect(['TIMED_OUT']).toContain(row.status);
      expect(await errandStatus(errandId)).toBe('OPEN');
    }
    await assertAgreement();
  });

  it('an expired errand never accepts a selection and closes every offer', async () => {
    const requester = await signedInUser(app);
    const errandId = await openErrand(app, requester, categoryId);
    const a = await addOffer(app, errandId);
    await prisma.$executeRaw`UPDATE errands SET expires_at = now() - interval '1 minute' WHERE id = ${errandId}::uuid`;

    const res = await selectRunner(app, requester, errandId, a.offerId, a.offerVersion);

    expect(res.body.error.code).toBe('ERRAND_EXPIRED');
    expect(await prisma.assignment.count({ where: { errandId } })).toBe(0);
  });

  it('every state-changing execution call is safe to retry with the same idempotency key', async () => {
    const requester = await signedInUser(app);
    const errandId = await openErrand(app, requester, categoryId);
    const a = await addOffer(app, errandId);
    const key = randomUUID();
    const first = await selectRunner(app, requester, errandId, a.offerId, a.offerVersion, key).expect(201);
    const second = await selectRunner(app, requester, errandId, a.offerId, a.offerVersion, key).expect(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const acceptKey = randomUUID();
    await acceptAssignment(app, a.runner, first.body.data.id, acceptKey).expect(201);
    await acceptAssignment(app, a.runner, first.body.data.id, acceptKey).expect(201);
    const startKey = randomUUID();
    await executionStep(app, a.runner, first.body.data.id, 'start', {}, startKey).expect(201);
    await executionStep(app, a.runner, first.body.data.id, 'start', {}, startKey).expect(201);

    expect(await prisma.executionEvent.count({ where: { assignmentId: first.body.data.id, type: 'STARTED' } })).toBe(1);
    expect(await prisma.paymentAgreement.count({ where: { assignmentId: first.body.data.id } })).toBe(1);
  });
});

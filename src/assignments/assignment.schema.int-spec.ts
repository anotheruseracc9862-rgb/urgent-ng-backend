/**
 * P7-01 constraint tests: what the database itself refuses, whatever the application does
 * (Backend PRD 3.5, 26.2, A.7). Raw SQL on purpose.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { seedPolicies, signedInUser } from '../test/auth.helper.js';
import { insertErrand, seedCategories } from '../test/errand.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Assignment and execution schema (P7-01)', () => {
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

  async function scene() {
    const requester = await signedInUser(app);
    const runner = await signedInUser(app);
    const other = await signedInUser(app);
    const errandId = await insertErrand({ requesterId: requester.userId, categoryId });
    const offer = await prisma.offer.create({
      data: {
        errandId,
        runnerId: runner.userId,
        requesterId: requester.userId,
        amountMinor: 50_000n,
        durationMinutes: 30,
        availabilityConfirmedAt: new Date(),
      },
    });
    return { requester, runner, other, errandId, offer };
  }

  type Scene = Awaited<ReturnType<typeof scene>>;

  const insertAssignment = (
    s: Scene,
    overrides: { status?: string; offerId?: string; runnerId?: string; requesterId?: string; errandId?: string; extra?: string } = {},
  ) => {
    const status = overrides.status ?? 'PENDING_ACCEPTANCE';
    const accepted = status === 'ACCEPTED' || status === 'COMPLETED' ? 'now()' : 'NULL';
    const completed = status === 'COMPLETED' ? 'now()' : 'NULL';
    return prisma.$executeRawUnsafe(
      `INSERT INTO assignments (errand_id, requester_id, runner_id, selected_offer_id, status, agreed_amount_minor,
                                selected_at, acceptance_deadline, accepted_at, completed_at, ${overrides.extra ? 'cancellation_reason, cancelled_at, cancelled_by_type,' : ''} updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"AssignmentStatus", 50000,
               now(), now() + interval '30 minutes', ${accepted}, ${completed}, ${overrides.extra ? `${overrides.extra},` : ''} now())`,
      overrides.errandId ?? s.errandId,
      overrides.requesterId ?? s.requester.userId,
      overrides.runnerId ?? s.runner.userId,
      overrides.offerId ?? s.offer.id,
      status,
    );
  };

  const secondOffer = (s: Scene, runnerId: string) =>
    prisma.offer.create({
      data: {
        errandId: s.errandId,
        runnerId,
        requesterId: s.requester.userId,
        amountMinor: 40_000n,
        durationMinutes: 20,
        availabilityConfirmedAt: new Date(),
      },
    });

  describe('assignments', () => {
    it('accepts a consistent pending assignment and defaults its status and currency', async () => {
      const s = await scene();
      await insertAssignment(s);
      const row = await prisma.assignment.findFirstOrThrow({ where: { errandId: s.errandId } });
      expect(row).toMatchObject({ status: 'PENDING_ACCEPTANCE', currency: 'NGN', version: 0 });
      expect(Number(row.agreedAmountMinor)).toBe(50_000);
    });

    it('allows only one live assignment per errand, but history does not block a new one', async () => {
      const s = await scene();
      await insertAssignment(s);
      const second = await secondOffer(s, s.other.userId);

      await expect(insertAssignment(s, { offerId: second.id, runnerId: s.other.userId })).rejects.toThrow(/already exists/);

      await prisma.$executeRaw`UPDATE assignments SET status = 'DECLINED'::"AssignmentStatus", declined_at = now() WHERE errand_id = ${s.errandId}::uuid`;
      await insertAssignment(s, { offerId: second.id, runnerId: s.other.userId });
      expect(await prisma.assignment.count({ where: { errandId: s.errandId } })).toBe(2);
    });

    it('lets an offer be selected only once', async () => {
      const s = await scene();
      await insertAssignment(s);
      await prisma.$executeRaw`UPDATE assignments SET status = 'TIMED_OUT'::"AssignmentStatus", timed_out_at = now() WHERE errand_id = ${s.errandId}::uuid`;
      await expect(insertAssignment(s)).rejects.toThrow(/already exists/);
    });

    it('rejects a requester or runner that does not match the errand and offer', async () => {
      const s = await scene();
      await expect(insertAssignment(s, { requesterId: s.other.userId })).rejects.toThrow(/does not match/);
      await expect(insertAssignment(s, { runnerId: s.other.userId })).rejects.toThrow(/does not match/);
    });

    it('rejects an offer from another errand', async () => {
      const s = await scene();
      const elsewhere = await insertErrand({ requesterId: s.requester.userId, categoryId });
      const foreign = await prisma.offer.create({
        data: {
          errandId: elsewhere,
          runnerId: s.runner.userId,
          requesterId: s.requester.userId,
          amountMinor: 50_000n,
          durationMinutes: 30,
          availabilityConfirmedAt: new Date(),
        },
      });
      await expect(insertAssignment(s, { offerId: foreign.id })).rejects.toThrow(/does not match/);
    });

    it('rejects requester equal to runner', async () => {
      const s = await scene();
      await expect(insertAssignment(s, { requesterId: s.runner.userId, runnerId: s.runner.userId })).rejects.toThrow();
    });

    it('requires the timestamp that explains the status', async () => {
      const s = await scene();
      await insertAssignment(s);
      for (const status of ['ACCEPTED', 'DECLINED', 'TIMED_OUT', 'CANCELLED', 'COMPLETED']) {
        await expect(
          prisma.$executeRawUnsafe(`UPDATE assignments SET status = '${status}'::"AssignmentStatus" WHERE errand_id = $1::uuid`, s.errandId),
          status,
        ).rejects.toThrow(/assignments_status_fields/);
      }
    });

    it('refuses a pending assignment that already carries an outcome timestamp', async () => {
      const s = await scene();
      await insertAssignment(s);
      await expect(
        prisma.$executeRaw`UPDATE assignments SET accepted_at = now() WHERE errand_id = ${s.errandId}::uuid`,
      ).rejects.toThrow(/assignments_status_fields/);
    });

    it('needs a reason and an actor type to be cancelled', async () => {
      const s = await scene();
      await insertAssignment(s);
      await expect(
        prisma.$executeRaw`UPDATE assignments SET status = 'CANCELLED'::"AssignmentStatus", cancelled_at = now() WHERE errand_id = ${s.errandId}::uuid`,
      ).rejects.toThrow(/assignments_status_fields/);
      await prisma.$executeRaw`
        UPDATE assignments SET status = 'CANCELLED'::"AssignmentStatus", cancelled_at = now(),
               cancellation_reason = 'REQUESTER_CANCELLED'::"ErrandCancellationReason", cancelled_by_type = 'USER'::"AuditActorType"
        WHERE errand_id = ${s.errandId}::uuid`;
    });

    it('requires a positive amount in NGN', async () => {
      const s = await scene();
      await insertAssignment(s);
      await expect(prisma.$executeRaw`UPDATE assignments SET agreed_amount_minor = 0 WHERE errand_id = ${s.errandId}::uuid`).rejects.toThrow();
      await expect(prisma.$executeRaw`UPDATE assignments SET currency = 'USD' WHERE errand_id = ${s.errandId}::uuid`).rejects.toThrow();
    });

    it('cannot be physically deleted', async () => {
      const s = await scene();
      await insertAssignment(s);
      await expect(prisma.$executeRaw`DELETE FROM assignments WHERE errand_id = ${s.errandId}::uuid`).rejects.toThrow();
    });
  });

  describe('execution events, checkpoints, problems, change requests, payment agreement', () => {
    async function assignment() {
      const s = await scene();
      await insertAssignment(s, { status: 'ACCEPTED' });
      const row = await prisma.assignment.findFirstOrThrow({ where: { errandId: s.errandId } });
      return { ...s, assignmentId: row.id };
    }

    it('execution events are immutable and cannot be deleted', async () => {
      const a = await assignment();
      await prisma.executionEvent.create({
        data: { assignmentId: a.assignmentId, errandId: a.errandId, type: 'STARTED', actorId: a.runner.userId, actorType: 'USER' },
      });
      await expect(prisma.$executeRaw`UPDATE execution_events SET note = 'x' WHERE assignment_id = ${a.assignmentId}::uuid`).rejects.toThrow(/immutable/);
      await expect(prisma.$executeRaw`DELETE FROM execution_events WHERE assignment_id = ${a.assignmentId}::uuid`).rejects.toThrow();
    });

    it('allows one pickup and one delivery checkpoint, and stores a private point', async () => {
      const a = await assignment();
      await prisma.$executeRaw`
        INSERT INTO checkpoints (assignment_id, type, point, captured_at)
        VALUES (${a.assignmentId}::uuid, 'PICKUP'::"CheckpointType", ST_SetSRID(ST_MakePoint(3.3792, 6.5244), 4326)::geography, now())`;
      await expect(
        prisma.$executeRaw`INSERT INTO checkpoints (assignment_id, type, captured_at) VALUES (${a.assignmentId}::uuid, 'PICKUP'::"CheckpointType", now())`,
      ).rejects.toThrow(/already exists/);
      await prisma.$executeRaw`INSERT INTO checkpoints (assignment_id, type, captured_at) VALUES (${a.assignmentId}::uuid, 'DELIVERY'::"CheckpointType", now())`;
      await expect(prisma.$executeRaw`DELETE FROM checkpoints WHERE assignment_id = ${a.assignmentId}::uuid`).rejects.toThrow();
    });

    it('allows one pending change request per assignment', async () => {
      const a = await assignment();
      const make = (status: 'PENDING' | 'REJECTED' = 'PENDING') =>
        prisma.changeRequest.create({
          data: {
            assignmentId: a.assignmentId,
            requestedBy: a.requester.userId,
            type: 'AMOUNT',
            payload: { amountMinor: 60_000 },
            status,
            expiresAt: new Date(Date.now() + 2 * 3_600_000),
            ...(status === 'REJECTED' ? { respondedBy: a.runner.userId, respondedAt: new Date() } : {}),
          },
        });
      await make('REJECTED');
      await make('PENDING');
      await expect(make('PENDING')).rejects.toThrow();
      expect(await prisma.changeRequest.count({ where: { assignmentId: a.assignmentId } })).toBe(2);
    });

    it('requires an answer and an answerer on an accepted change request, and not the requester', async () => {
      const a = await assignment();
      const cr = await prisma.changeRequest.create({
        data: { assignmentId: a.assignmentId, requestedBy: a.requester.userId, type: 'OTHER', payload: { note: 'x' }, expiresAt: new Date(Date.now() + 3_600_000) },
      });
      await expect(
        prisma.$executeRaw`UPDATE change_requests SET status = 'ACCEPTED'::"ChangeRequestStatus" WHERE id = ${cr.id}::uuid`,
      ).rejects.toThrow(/change_requests_pending_fields/);
      await expect(
        prisma.$executeRaw`UPDATE change_requests SET status = 'ACCEPTED'::"ChangeRequestStatus", responded_at = now(), responded_by = ${a.requester.userId}::uuid WHERE id = ${cr.id}::uuid`,
      ).rejects.toThrow(/change_requests_responder_differs/);
    });

    it('keeps one payment agreement per assignment and refuses a non-positive amount', async () => {
      const a = await assignment();
      await prisma.paymentAgreement.create({ data: { assignmentId: a.assignmentId, agreedAmountMinor: 50_000n } });
      await expect(prisma.paymentAgreement.create({ data: { assignmentId: a.assignmentId, agreedAmountMinor: 50_000n } })).rejects.toThrow();
      await expect(prisma.$executeRaw`UPDATE payment_agreements SET agreed_amount_minor = 0 WHERE assignment_id = ${a.assignmentId}::uuid`).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM payment_agreements WHERE assignment_id = ${a.assignmentId}::uuid`).rejects.toThrow();
    });

    it('execution problems are OPEN or RESOLVED, and resolved ones carry the time', async () => {
      const a = await assignment();
      const problem = await prisma.executionProblem.create({
        data: { assignmentId: a.assignmentId, reportedBy: a.runner.userId, type: 'ITEM_NOT_READY' },
      });
      expect(problem.status).toBe('OPEN');
      await expect(prisma.$executeRaw`UPDATE execution_problems SET status = 'DONE' WHERE id = ${problem.id}::uuid`).rejects.toThrow();
      await expect(prisma.$executeRaw`UPDATE execution_problems SET status = 'RESOLVED' WHERE id = ${problem.id}::uuid`).rejects.toThrow(/resolved_fields/);
      await prisma.$executeRaw`UPDATE execution_problems SET status = 'RESOLVED', resolved_at = now() WHERE id = ${problem.id}::uuid`;
    });
  });
});

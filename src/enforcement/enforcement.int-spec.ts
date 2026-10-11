/**
 * P9-04: enforcement (Backend PRD 21.4, 21.7). The ladder, admin actions, review cases, appeals
 * and the suspension policy for work already under way. Real PostgreSQL and Redis.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { acceptedScene, completedScene, executionStep, offerScene } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { BlocklistService } from '../auth/blocklist.service.js';
import { ReliabilityService } from '../reliability/reliability.service.js';
import { ReportService } from '../reports/report.service.js';
import { EnforcementService } from './enforcement.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Enforcement (P9-04)', () => {
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
  const enforcement = () => app.get(EnforcementService);
  let counter = 0;
  /** Give a user `points` of reliability points, in steps of 4 (a no-show each). */
  async function addPoints(userId: string, points: number) {
    const service = app.get(ReliabilityService);
    for (let done = 0; done < points; done += 4) {
      counter += 1;
      await service.recordStandalone({ userId, type: 'NO_SHOW', source: 'SYSTEM', dedupeKey: `test:${counter}:${userId}` });
    }
  }
  const actions = (userId: string) => prisma.enforcementAction.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  const userStatus = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).status;
  const adminId = async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO admins (email, display_name, password_hash, status, updated_at)
      VALUES (${`admin-${randomUUID()}@urgent.ng`}, 'Test Admin', 'x', 'ACTIVE'::"AdminStatus", now())
      RETURNING id::text`;
    return rows[0].id;
  };
  const get = (user: Authed, path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(user.accessToken));

  describe('the ladder', () => {
    it('does nothing below the warning threshold', async () => {
      const user = await signedInUser(app);
      await prisma.$executeRaw`
        INSERT INTO reliability_events (user_id, event_type, severity, occurred_at, source, dedupe_key)
        VALUES (${user.userId}::uuid, 'ASSIGNMENT_TIMEOUT', 3, now(), 'SYSTEM'::"AuditActorType", 'test:three')`;

      const result = await enforcement().evaluate(user.userId);

      expect(result).toEqual({ applied: [], reviewOpened: false });
      expect(await actions(user.userId)).toHaveLength(0);
      expect(await userStatus(user.userId)).toBe('ACTIVE');
    });

    it('warns at 4 points, restricts at 8, suspends at 12 and asks an admin at 16', async () => {
      const user = await signedInUser(app);

      await addPoints(user.userId, 4);
      expect(await enforcement().evaluate(user.userId)).toEqual({ applied: ['WARNING'], reviewOpened: false });
      await addPoints(user.userId, 4);
      expect((await enforcement().evaluate(user.userId)).applied).toEqual(['FEATURE_RESTRICTION']);
      await addPoints(user.userId, 4);
      expect((await enforcement().evaluate(user.userId)).applied).toEqual(['TEMPORARY_SUSPENSION']);
      await addPoints(user.userId, 4);
      expect(await enforcement().evaluate(user.userId)).toEqual({ applied: [], reviewOpened: true });

      const rows = await actions(user.userId);
      expect(rows.map((r) => [r.type, r.trigger, r.ladderLevel, r.actorType])).toEqual([
        ['WARNING', 'LADDER', 'WARNING', 'SYSTEM'],
        ['FEATURE_RESTRICTION', 'LADDER', 'RESTRICTION', 'SYSTEM'],
        ['TEMPORARY_SUSPENSION', 'LADDER', 'SUSPENSION', 'SYSTEM'],
      ]);
      // 7 and 30 days from the database clock, and a ladder suspension is not safety-critical.
      const day = 86_400_000;
      expect(rows[0].endsAt).toBeNull();
      expect(rows[1].endsAt!.getTime() - rows[1].startsAt.getTime()).toBe(7 * day);
      expect(rows[2].endsAt!.getTime() - rows[2].startsAt.getTime()).toBe(30 * day);
      expect(rows[2].safetyCritical).toBe(false);
      expect(await userStatus(user.userId)).toBe('SUSPENDED');
      const review = await prisma.enforcementReview.findFirstOrThrow({ where: { userId: user.userId } });
      expect(review).toMatchObject({ trigger: 'LADDER_ADMIN_REVIEW', status: 'OPEN', points: 16 });
    });

    it('applies each level once per window, however many events arrive', async () => {
      const user = await signedInUser(app);
      await addPoints(user.userId, 8);

      await enforcement().evaluate(user.userId);
      await enforcement().evaluate(user.userId);
      await Promise.all([enforcement().evaluate(user.userId), enforcement().evaluate(user.userId)]);

      expect(await actions(user.userId)).toHaveLength(2);
      expect(await prisma.userRestriction.count({ where: { userId: user.userId } })).toBe(2);
    });

    it('links every action to the events it rests on', async () => {
      const user = await signedInUser(app);
      await addPoints(user.userId, 8);
      await enforcement().evaluate(user.userId);

      const rows = await actions(user.userId);
      const events = await prisma.reliabilityEvent.findMany({ where: { userId: user.userId } });
      for (const action of rows) {
        const linked = await prisma.enforcementActionEvent.findMany({ where: { enforcementActionId: action.id } });
        expect(linked.map((l) => l.reliabilityEventId).sort(), action.type).toEqual(events.map((e) => e.id).sort());
      }
    });

    it('runs from the reliability event, in the worker path', async () => {
      const user = await signedInUser(app);
      await addPoints(user.userId, 4);
      expect(await actions(user.userId)).toHaveLength(0);

      await dispatchOutbox(app, { eventType: 'reliability.recorded' });

      expect((await actions(user.userId)).map((a) => a.type)).toEqual(['WARNING']);
    });

    it('ignores points that left the window', async () => {
      const user = await signedInUser(app);
      await prisma.$executeRaw`
        INSERT INTO reliability_events (user_id, event_type, severity, occurred_at, source, dedupe_key)
        VALUES (${user.userId}::uuid, 'NO_SHOW', 4, now() - interval '91 days', 'SYSTEM'::"AuditActorType", 'test:old-1'),
               (${user.userId}::uuid, 'NO_SHOW', 4, now() - interval '100 days', 'SYSTEM'::"AuditActorType", 'test:old-2')`;

      expect((await enforcement().evaluate(user.userId)).applied).toEqual([]);
    });
  });

  describe('what each action does', () => {
    it('a restriction pauses offering and posting, and ends with its window', async () => {
      const s = await offerScene(app, categoryId);
      await addPoints(s.runner.userId, 8);
      await enforcement().evaluate(s.runner.userId);

      const restrictions = await prisma.userRestriction.findMany({ where: { userId: s.runner.userId } });
      expect(restrictions.map((r) => r.type).sort()).toEqual(['OFFERING', 'POSTING']);
      expect(restrictions.every((r) => r.status === 'ACTIVE')).toBe(true);
      const offer = await request(app.getHttpServer())
        .post(`${API}/errands/${s.errandId}/offers`)
        .set(...bearer(s.runner.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: 50_000, durationMinutes: 30, availabilityConfirmed: true });
      expect([403, 409]).toContain(offer.status);

      await prisma.$executeRaw`UPDATE enforcement_actions SET ends_at = now() - interval '1 minute', starts_at = now() - interval '8 days' WHERE type = 'FEATURE_RESTRICTION'`;
      expect(await enforcement().expireDue()).toBe(1);
      expect(await enforcement().expireDue()).toBe(0);

      expect((await prisma.enforcementAction.findFirstOrThrow({ where: { type: 'FEATURE_RESTRICTION' } })).status).toBe('EXPIRED');
      expect((await prisma.userRestriction.findMany({ where: { userId: s.runner.userId } })).every((r) => r.status === 'EXPIRED')).toBe(true);
    });

    it('a suspension blocks the account, and lifts when it ends', async () => {
      const user = await signedInUser(app);
      await addPoints(user.userId, 12);
      await enforcement().evaluate(user.userId);
      expect(await userStatus(user.userId)).toBe('SUSPENDED');

      const blocked = await request(app.getHttpServer())
        .post(`${API}/errands`)
        .set(...bearer(user.accessToken))
        .send({});
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('ACCOUNT_SUSPENDED');

      await prisma.$executeRaw`UPDATE enforcement_actions SET ends_at = now() - interval '1 minute', starts_at = now() - interval '31 days' WHERE type = 'TEMPORARY_SUSPENSION'`;
      await enforcement().expireDue();

      expect(await userStatus(user.userId)).toBe('ACTIVE');
    });

    it('an admin permanent suspension blocks the phone and email, and has no end', async () => {
      const user = await signedInUser(app);
      const admin = await adminId();
      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });

      const action = await enforcement().adminApply(
        { userId: user.userId, type: 'PERMANENT_SUSPENSION', reason: 'Confirmed fraud.' },
        { adminId: admin },
      );

      expect(action).toMatchObject({ trigger: 'ADMIN', actorType: 'ADMIN', actorId: admin, endsAt: null, safetyCritical: true });
      expect(await userStatus(user.userId)).toBe('SUSPENDED');
      const blocklist = app.get(BlocklistService);
      if (row.phoneE164) expect(await blocklist.isPhoneBlocked(row.phoneE164)).toBe(true);
      if (row.email) expect(await blocklist.isEmailBlocked(row.email)).toBe(true);
      const entries = await prisma.blocklistEntry.findMany({ where: { sourceEnforcementId: action.id } });
      expect(entries.length).toBeGreaterThan(0);
    });

    it('validates admin actions', async () => {
      const user = await signedInUser(app);
      const admin = { adminId: await adminId() };
      const apply = (input: Record<string, unknown>) =>
        enforcement().adminApply({ userId: user.userId, reason: 'because', ...input } as never, admin);

      await expect(apply({ type: 'TEMPORARY_SUSPENSION' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(apply({ type: 'FEATURE_RESTRICTION' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(apply({ type: 'BADGE_REMOVAL' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(apply({ type: 'WARNING', reason: '  ' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await actions(user.userId)).toHaveLength(0);
    });

    it('removes a rating and keeps the figures honest', async () => {
      const s = await completedScene(app, categoryId);
      const rate = (user: Authed, overall: number) =>
        request(app.getHttpServer())
          .post(`${API}/assignments/${s.assignmentId}/ratings`)
          .set(...bearer(user.accessToken))
          .set('Idempotency-Key', randomUUID())
          .send({ scores: { overall } });
      await rate(s.requester, 1).expect(201);
      await rate(s.runner, 5).expect(201);
      const rating = await prisma.rating.findFirstOrThrow({ where: { rateeId: s.runner.userId } });
      expect((await prisma.userStats.findUniqueOrThrow({ where: { userId: s.runner.userId } })).runnerRatingCount).toBe(1);

      await enforcement().adminApply(
        { userId: s.requester.userId, type: 'CONTENT_REMOVAL', reason: 'Abusive review.', content: { type: 'RATING', id: rating.id } },
        { adminId: await adminId() },
      );

      expect((await prisma.rating.findUniqueOrThrow({ where: { id: rating.id } })).status).toBe('REMOVED');
      expect((await prisma.userStats.findUniqueOrThrow({ where: { userId: s.runner.userId } })).runnerRatingCount).toBe(0);
    });

    it('records a badge removal with its badge', async () => {
      const user = await signedInUser(app);
      const action = await enforcement().adminApply(
        { userId: user.userId, type: 'BADGE_REMOVAL', reason: 'Misleading profile.', badge: 'TRUSTED' },
        { adminId: await adminId() },
      );
      expect(action).toMatchObject({ type: 'BADGE_REMOVAL', targetBadge: 'TRUSTED', status: 'ACTIVE' });
    });
  });

  describe('suspension during an active assignment (Backend PRD 21.4)', () => {
    const suspend = async (userId: string, safetyCritical: boolean) =>
      enforcement().adminApply(
        { userId, type: 'TEMPORARY_SUSPENSION', reason: 'Review.', durationDays: 7, safetyCritical },
        { adminId: await adminId() },
      );

    it('a lower-level suspension lets the runner finish the errand, but not take new work', async () => {
      const s = await acceptedScene(app, categoryId);
      await suspend(s.runner.userId, false);
      expect(await userStatus(s.runner.userId)).toBe('SUSPENDED');

      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);
      await executionStep(app, s.runner, s.assignmentId, 'pickup').expect(201);

      const fresh = await offerScene(app, categoryId);
      const offer = await request(app.getHttpServer())
        .post(`${API}/errands/${fresh.errandId}/offers`)
        .set(...bearer(s.runner.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: 50_000, durationMinutes: 30, availabilityConfirmed: true });
      expect(offer.status).toBe(403);
      expect(offer.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('a safety-critical suspension stops execution at once', async () => {
      const s = await acceptedScene(app, categoryId);
      await suspend(s.runner.userId, true);

      const res = await executionStep(app, s.runner, s.assignmentId, 'start');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect(res.body.error.details.reason).toBe('SAFETY_CRITICAL');
    });

    it('the other party is not affected', async () => {
      const s = await acceptedScene(app, categoryId);
      await suspend(s.runner.userId, true);

      const res = await get(s.requester, `/assignments/${s.assignmentId}`);

      expect(res.status).toBe(200);
    });
  });

  describe('review cases', () => {
    it('an upheld fraud report goes to an admin, with nothing applied automatically', async () => {
      const s = await completedScene(app, categoryId);
      const filed = (
        await request(app.getHttpServer())
          .post(`${API}/reports`)
          .set(...bearer(s.requester.accessToken))
          .set('Idempotency-Key', randomUUID())
          .send({ targetType: 'USER', targetId: s.runner.userId, type: 'FRAUD', description: 'Took the item and vanished.', assignmentId: s.assignmentId })
          .expect(201)
      ).body.data;
      const admin = await adminId();

      await app.get(ReportService).adminResolve(filed.id, { outcome: 'UPHELD', resolution: 'Confirmed.' }, { adminId: admin });

      const review = await prisma.enforcementReview.findFirstOrThrow({ where: { userId: s.runner.userId } });
      expect(review).toMatchObject({ trigger: 'SEVERE_EVENT', status: 'OPEN', caseRef: `report:${filed.id}` });
      expect(await actions(s.runner.userId)).toHaveLength(0);
      expect(await userStatus(s.runner.userId)).toBe('ACTIVE');

      const action = await enforcement().adminApply(
        { userId: s.runner.userId, type: 'PERMANENT_SUSPENSION', reason: 'Fraud confirmed.', caseRef: `report:${filed.id}` },
        { adminId: admin, reviewId: review.id },
      );

      expect(await prisma.enforcementReview.findUniqueOrThrow({ where: { id: review.id } })).toMatchObject({
        status: 'ACTIONED',
        resultingActionId: action.id,
        decidedBy: admin,
      });
      expect(action.trigger).toBe('SEVERE_EVENT');
    });

    it('keeps one open review per user and trigger, and lets an admin dismiss it', async () => {
      const user = await signedInUser(app);
      const admin = await adminId();
      const flag = () => prisma.$transaction((tx) => enforcement().flagSevere(tx, user.userId, { reason: 'Prohibited item.' }));

      expect(await flag()).toBe(true);
      expect(await flag()).toBe(false);
      const review = await prisma.enforcementReview.findFirstOrThrow({ where: { userId: user.userId } });

      await enforcement().dismissReview(review.id, 'No grounds.', { adminId: admin });

      expect((await prisma.enforcementReview.findUniqueOrThrow({ where: { id: review.id } })).status).toBe('DISMISSED');
      await expect(enforcement().dismissReview(review.id, 'again', { adminId: admin })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(await flag()).toBe(true);
    });
  });

  describe('account standing and appeals', () => {
    it('shows the user their own actions, even when suspended', async () => {
      const user = await signedInUser(app);
      await addPoints(user.userId, 12);
      await enforcement().evaluate(user.userId);

      const res = await get(user, '/me/enforcement').expect(200);

      expect(res.body.data.map((a: { type: string }) => a.type).sort()).toEqual(['FEATURE_RESTRICTION', 'TEMPORARY_SUSPENSION', 'WARNING']);
      const suspension = res.body.data.find((a: { type: string }) => a.type === 'TEMPORARY_SUSPENSION');
      expect(suspension).toMatchObject({ status: 'ACTIVE', canAppeal: true });
      expect(suspension.reason).toContain('reliability points');
      expect(res.body.data.find((a: { type: string }) => a.type === 'WARNING').canAppeal).toBe(false);
    });

    it('lets a suspended user appeal once, and an admin lift the action', async () => {
      const user = await signedInUser(app);
      await addPoints(user.userId, 12);
      await enforcement().evaluate(user.userId);
      const suspension = (await actions(user.userId)).find((a) => a.type === 'TEMPORARY_SUSPENSION')!;
      const appeal = (user_: Authed, id: string, note = 'These cancellations were not mine.') =>
        request(app.getHttpServer()).post(`${API}/enforcement/${id}/appeal`).set(...bearer(user_.accessToken)).send({ note });

      const first = await appeal(user, suspension.id).expect(201);
      expect(first.body.data.appeal.requestedAt).toBeTruthy();
      expect(first.body.data.appeal.dueAt).toBeTruthy();
      expect((await appeal(user, suspension.id)).status).toBe(409);
      expect((await appeal(user, suspension.id, '')).status).toBe(400);
      const other = await signedInUser(app);
      expect((await appeal(other, suspension.id)).status).toBe(404);

      const decided = await enforcement().adminDecideAppeal(suspension.id, 'REVOKED', 'Evidence shows the cancellations were forced.', {
        adminId: await adminId(),
      });

      expect(decided).toMatchObject({ status: 'REVOKED', appealOutcome: 'REVOKED' });
      expect(await userStatus(user.userId)).toBe('ACTIVE');
      // The same points do not bring the action back.
      await addPoints(user.userId, 4);
      await enforcement().evaluate(user.userId);
      expect((await actions(user.userId)).filter((a) => a.type === 'TEMPORARY_SUSPENSION')).toHaveLength(1);
      await expect(enforcement().adminDecideAppeal(suspension.id, 'UPHELD', 'again', { adminId: await adminId() })).rejects.toMatchObject({
        code: 'ERRAND_INVALID_STATE',
      });
    });

    it('an upheld appeal leaves the action in place', async () => {
      const user = await signedInUser(app);
      await addPoints(user.userId, 12);
      await enforcement().evaluate(user.userId);
      const suspension = (await actions(user.userId)).find((a) => a.type === 'TEMPORARY_SUSPENSION')!;
      await request(app.getHttpServer())
        .post(`${API}/enforcement/${suspension.id}/appeal`)
        .set(...bearer(user.accessToken))
        .send({ note: 'Please reconsider.' })
        .expect(201);

      const decided = await enforcement().adminDecideAppeal(suspension.id, 'UPHELD', 'The record is correct.', { adminId: await adminId() });

      expect(decided).toMatchObject({ status: 'ACTIVE', appealOutcome: 'UPHELD' });
      expect(await userStatus(user.userId)).toBe('SUSPENDED');
    });

    it('tells the user in the safety class, without the reason', async () => {
      const user = await signedInUser(app);
      await addPoints(user.userId, 4);
      await enforcement().evaluate(user.userId);
      await dispatchOutbox(app, { eventType: 'enforcement.applied' });

      const res = await get(user, '/notifications').expect(200);

      const notice = (res.body.data as Array<{ type: string; body: string }>).find((n) => n.type === 'enforcement.warning');
      expect(notice).toBeTruthy();
      expect(notice!.body).not.toContain('reliability points');
    });
  });

  describe('schema', () => {
    it('refuses a permanent suspension with an end, a temporary one without, and any deletion', async () => {
      const user = await signedInUser(app);
      const insert = (type: string, endsAt: string | null) =>
        prisma.$executeRawUnsafe(
          `INSERT INTO enforcement_actions (user_id, type, reason, trigger, actor_type, starts_at, ends_at, updated_at)
           VALUES ($1::uuid, $2::"EnforcementActionType", 'r', 'ADMIN', 'ADMIN'::"AuditActorType", now(), ${endsAt ? `now() + interval '${endsAt}'` : 'NULL'}, now())`,
          user.userId,
          type,
        );

      await expect(insert('PERMANENT_SUSPENSION', '1 day')).rejects.toThrow();
      await expect(insert('TEMPORARY_SUSPENSION', null)).rejects.toThrow();
      await expect(insert('PERMANENT_SUSPENSION', null)).resolves.toBeDefined();
      await expect(prisma.$executeRaw`DELETE FROM enforcement_actions WHERE user_id = ${user.userId}::uuid`).rejects.toThrow();
    });
  });
});

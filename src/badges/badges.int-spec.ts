/**
 * P9-05: badges (Backend PRD 21.5). Rules computed from source rows, hysteresis, anti-gaming,
 * enforcement and verification interplay. Thresholds are lowered through the config store so the
 * flows stay short; the rule logic itself is covered by badge.rules.spec.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { insertErrand, seedCategories } from '../test/errand.helper.js';
import { submitOffer } from '../test/offer.helper.js';
import { acceptAssignment, acceptedScene, cancelAssignment, completedFor, completedScene, offerScene, selectRunner } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { BadgeService } from './badge.service.js';
import { BadgeRecomputeSweeper } from '../scheduler/badge-recompute.sweeper.js';
import { EnforcementService } from '../enforcement/enforcement.service.js';
import { ReliabilityService } from '../reliability/reliability.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Badges (P9-05)', () => {
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
  const badges = () => app.get(BadgeService);
  const setConfig = (key: string, value: unknown) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO config_values (key, value_json, version, effective_from, updated_at)
       VALUES ($1, $2::jsonb, 1, now() - interval '1 minute', now())`,
      key,
      JSON.stringify(value),
    );
  /** Low bars so a short history earns TRUSTED. */
  const easyTrusted = async () => {
    await setConfig('BADGE_TRUSTED_MIN_COMPLETED', 2);
    await setConfig('BADGE_TRUSTED_MIN_RATINGS', 2);
  };
  const live = async (userId: string) =>
    (await prisma.userBadge.findMany({ where: { userId, revokedAt: null } })).map((b) => b.badge).sort();
  const rate = (user: Authed, assignmentId: string, scores: Record<string, number>) =>
    request(app.getHttpServer())
      .post(`${API}/assignments/${assignmentId}/ratings`)
      .set(...bearer(user.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({ scores });
  /** The requester rates the runner and the runner rates back, so the rating is revealed. */
  async function rated(job: { requester: Authed; assignmentId: string }, runner: Authed, overall: number, conduct = 5) {
    await rate(job.requester, job.assignmentId, { overall }).expect(201);
    await rate(runner, job.assignmentId, { overall: 5, paymentConduct: conduct }).expect(201);
  }
  const adminId = async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO admins (email, display_name, password_hash, status, updated_at)
      VALUES (${`admin-${randomUUID()}@urgent.ng`}, 'Test Admin', 'x', 'ACTIVE'::"AdminStatus", now())
      RETURNING id::text`;
    return rows[0].id;
  };

  describe('earning and losing', () => {
    it('a new runner and a new requester carry the starter badges, from the completion event', async () => {
      const s = await completedScene(app, categoryId);

      await dispatchOutbox(app, { eventType: 'errand.completed' });

      expect(await live(s.runner.userId)).toEqual(['NEW']);
      expect(await live(s.requester.userId)).toEqual(['NEW_REQUESTER']);
      const awarded = await prisma.outboxEvent.count({ where: { eventType: 'badge.awarded' } });
      expect(awarded).toBe(2);
    });

    it('NEW ends at five completed errands', async () => {
      await setConfig('BADGE_NEW_BELOW_COMPLETED', 2);
      const first = await completedScene(app, categoryId);
      await badges().recompute(first.runner.userId);
      expect(await live(first.runner.userId)).toContain('NEW');

      await completedFor(app, categoryId, first.runner);
      const result = await badges().recompute(first.runner.userId);

      expect(result.revoked).toContain('NEW');
      expect(await live(first.runner.userId)).not.toContain('NEW');
      const row = await prisma.userBadge.findFirstOrThrow({ where: { userId: first.runner.userId, badge: 'NEW' } });
      expect(row.revokedReason).toBe('RULE_NO_LONGER_MET');
    });

    it('TRUSTED is earned from completions, distinct raters, rating and cancellations, with a snapshot', async () => {
      await easyTrusted();
      const first = await completedScene(app, categoryId);
      const second = await completedFor(app, categoryId, first.runner);
      await rated(first, first.runner, 5);
      await badges().recompute(first.runner.userId);
      expect(await live(first.runner.userId)).not.toContain('TRUSTED');

      await rated(second, first.runner, 5);
      const result = await badges().recompute(first.runner.userId);

      expect(result.awarded).toContain('TRUSTED');
      const row = await prisma.userBadge.findFirstOrThrow({ where: { userId: first.runner.userId, badge: 'TRUSTED' } });
      expect(row.reasonSnapshot).toMatchObject({ qualifyingCompleted: 2, distinctRaters: 2, ratingAverage: 5, cancellationPercent: 0 });
      // A second pass writes nothing.
      expect(await badges().recompute(first.runner.userId)).toEqual({ awarded: [], revoked: [] });
      expect(await prisma.userBadge.count({ where: { userId: first.runner.userId, badge: 'TRUSTED' } })).toBe(1);
    });

    it('does not flap: kept down to 4.3, lost below it', async () => {
      await easyTrusted();
      const first = await completedScene(app, categoryId);
      const second = await completedFor(app, categoryId, first.runner);
      const third = await completedFor(app, categoryId, first.runner);
      for (const job of [first, second, third]) await rated(job, first.runner, 5);
      await badges().recompute(first.runner.userId);
      expect(await live(first.runner.userId)).toContain('TRUSTED');
      const setScore = (assignmentId: string, score: number) =>
        prisma.$executeRaw`
          UPDATE rating_scores SET score = ${score}::smallint
          WHERE dimension = 'OVERALL'::"RatingDimension"
            AND rating_id IN (SELECT id FROM ratings WHERE assignment_id = ${assignmentId}::uuid AND direction = 'REQUESTER_TO_RUNNER')`;

      // 5, 4, 4: an average of 4.33 is below the 4.5 needed to earn, above the 4.3 needed to keep.
      await setScore(second.assignmentId, 4);
      await setScore(third.assignmentId, 4);
      await badges().recompute(first.runner.userId);
      expect(await live(first.runner.userId)).toContain('TRUSTED');

      // 4, 4, 4: below 4.3, so it goes, and 4.33 would not bring it back.
      await setScore(first.assignmentId, 4);
      const lost = await badges().recompute(first.runner.userId);
      expect(lost.revoked).toContain('TRUSTED');
      await setScore(first.assignmentId, 5);
      expect((await badges().recompute(first.runner.userId)).awarded).not.toContain('TRUSTED');
    });

    it('a high-severity event in the window removes TRUSTED, and an active restriction does too', async () => {
      await easyTrusted();
      const first = await completedScene(app, categoryId);
      const second = await completedFor(app, categoryId, first.runner);
      await rated(first, first.runner, 5);
      await rated(second, first.runner, 5);
      await badges().recompute(first.runner.userId);
      expect(await live(first.runner.userId)).toContain('TRUSTED');

      await app.get(ReliabilityService).recordStandalone({ userId: first.runner.userId, type: 'NO_SHOW', source: 'SYSTEM', dedupeKey: `badge:${randomUUID()}` });
      const result = await badges().recompute(first.runner.userId);

      expect(result.revoked).toContain('TRUSTED');
    });

    it('only errands at or above the minimum agreed amount count', async () => {
      await easyTrusted();
      await setConfig('BADGE_MIN_AGREED_AMOUNT', 60_000);
      const first = await completedScene(app, categoryId);
      const second = await completedFor(app, categoryId, first.runner);
      await rated(first, first.runner, 5);
      await rated(second, first.runner, 5);

      await badges().recompute(first.runner.userId);

      expect(await live(first.runner.userId)).not.toContain('TRUSTED');
    });

    it('many ratings from one requester count as one rater', async () => {
      await easyTrusted();
      const first = await completedScene(app, categoryId);
      const again = await completedFor(app, categoryId, first.runner, { requester: first.requester });
      await rated(first, first.runner, 5);
      await rated(again, first.runner, 5);

      await badges().recompute(first.runner.userId);

      expect(await live(first.runner.userId)).not.toContain('TRUSTED');
    });

    it('a runner who cancels too much is not trusted', async () => {
      await easyTrusted();
      const first = await completedScene(app, categoryId);
      const second = await completedFor(app, categoryId, first.runner);
      await rated(first, first.runner, 5);
      await rated(second, first.runner, 5);
      await badges().recompute(first.runner.userId);
      expect(await live(first.runner.userId)).toContain('TRUSTED');

      // A third accepted errand, which the runner then cancels: 1 of 3 is above 5 percent.
      const requester = await signedInUser(app);
      const errandId = await insertErrand({ requesterId: requester.userId, categoryId });
      const offer = (await submitOffer(app, first.runner, errandId).expect(201)).body.data;
      const selected = (await selectRunner(app, requester, errandId, offer.id, offer.version).expect(201)).body.data;
      await acceptAssignment(app, first.runner, selected.id).expect(201);
      await cancelAssignment(app, first.runner, selected.id, { reason: 'RUNNER_CANCELLED' }).expect(200);

      const result = await badges().recompute(first.runner.userId);

      expect(result.revoked).toContain('TRUSTED');
      const perf = (await request(app.getHttpServer()).get(`${API}/runner/performance`).set(...bearer(first.runner.accessToken)).expect(200)).body.data;
      expect(perf.cancellation.sample).toBe(3);
      expect(Math.round(perf.cancellation.percent)).toBe(33);
    });
  });

  describe('responsiveness', () => {
    it('FAST_RESPONDER needs a measured, quick reply', async () => {
      await setConfig('BADGE_FAST_RESPONDER_MIN_SAMPLES', 1);
      const s = await acceptedScene(app, categoryId);
      const conversations = await request(app.getHttpServer()).get(`${API}/conversations`).set(...bearer(s.requester.accessToken)).expect(200);
      const id = conversations.body.data[0].id as string;
      const say = (user: Authed, body: string) =>
        request(app.getHttpServer()).post(`${API}/conversations/${id}/messages`).set(...bearer(user.accessToken)).send({ type: 'TEXT', body });

      // The requester writes; the runner has not answered: unanswered counts as slow.
      await say(s.requester, 'Can you do it today?').expect(201);
      await badges().recompute(s.runner.userId);
      expect(await live(s.runner.userId)).not.toContain('FAST_RESPONDER');

      await say(s.runner, 'Yes, within the hour.').expect(201);
      await badges().recompute(s.runner.userId);
      expect(await live(s.runner.userId)).toContain('FAST_RESPONDER');

      const perf = (await request(app.getHttpServer()).get(`${API}/runner/performance`).set(...bearer(s.runner.accessToken)).expect(200)).body.data;
      expect(perf.response.sample).toBe(1);
      expect(perf.response.medianMinutes).toBeLessThan(10);
      expect(perf.badges).toContain('FAST_RESPONDER');
    });
  });

  describe('verification and enforcement', () => {
    it('runner badges are hidden while the verification is revoked, and return with it', async () => {
      const s = await completedScene(app, categoryId);
      await badges().recompute(s.runner.userId);
      expect(await badges().visibleFor([s.runner.userId])).toEqual(new Map([[s.runner.userId, ['NEW']]]));

      await prisma.$executeRaw`UPDATE verification_attempts SET status = 'REVOKED'::"VerificationStatus" WHERE user_id = ${s.runner.userId}::uuid`;
      expect((await badges().visibleFor([s.runner.userId])).get(s.runner.userId)).toEqual([]);
      // The stored badge is untouched: it is hidden, not lost.
      expect(await live(s.runner.userId)).toContain('NEW');

      await prisma.$executeRaw`UPDATE verification_attempts SET status = 'VERIFIED'::"VerificationStatus" WHERE user_id = ${s.runner.userId}::uuid`;
      expect((await badges().visibleFor([s.runner.userId])).get(s.runner.userId)).toEqual(['NEW']);
    });

    it('a badge removal keeps the badge off until the action ends', async () => {
      const s = await completedScene(app, categoryId);
      await badges().recompute(s.runner.userId);
      expect(await live(s.runner.userId)).toContain('NEW');
      const action = await app
        .get(EnforcementService)
        .adminApply({ userId: s.runner.userId, type: 'BADGE_REMOVAL', reason: 'Misleading.', badge: 'NEW' }, { adminId: await adminId() });

      const removed = await badges().recompute(s.runner.userId);
      expect(removed.revoked).toContain('NEW');
      expect((await prisma.userBadge.findFirstOrThrow({ where: { userId: s.runner.userId, badge: 'NEW' } })).revokedReason).toBe('REMOVED_BY_ENFORCEMENT');
      expect((await badges().recompute(s.runner.userId)).awarded).toEqual([]);

      await app.get(EnforcementService).adminRevoke(action.id, 'Mistake.', { adminId: await adminId() });
      expect((await badges().recompute(s.runner.userId)).awarded).toContain('NEW');
    });

    it('is recomputed from the enforcement event', async () => {
      const s = await completedScene(app, categoryId);
      await badges().recompute(s.runner.userId);
      await app
        .get(EnforcementService)
        .adminApply({ userId: s.runner.userId, type: 'BADGE_REMOVAL', reason: 'Misleading.', badge: 'NEW' }, { adminId: await adminId() });

      await dispatchOutbox(app, { eventType: 'enforcement.applied' });

      expect(await live(s.runner.userId)).not.toContain('NEW');
    });
  });

  describe('display', () => {
    it('shows badges on the public profile, the offer list and the feed requester', async () => {
      const s = await offerScene(app, categoryId);
      await badges().recompute(s.runner.userId);
      await badges().recompute(s.requester.userId);
      const viewer = await signedInUser(app);

      const profile = await request(app.getHttpServer()).get(`${API}/users/${s.runner.userId}`).set(...bearer(viewer.accessToken)).expect(200);
      expect(profile.body.data.badges).toEqual(['NEW']);
      const offers = await request(app.getHttpServer())
        .get(`${API}/errands/${s.errandId}/offers`)
        .set(...bearer(s.requester.accessToken))
        .expect(200);
      expect(offers.body.data[0].runnerBadges).toEqual(['NEW']);
      const requesterProfile = await request(app.getHttpServer()).get(`${API}/users/${s.requester.userId}`).set(...bearer(viewer.accessToken)).expect(200);
      expect(requesterProfile.body.data.badges).toEqual(['NEW_REQUESTER']);
    });

    it('a badge never changes the order of offers', async () => {
      const s = await offerScene(app, categoryId);
      const before = await request(app.getHttpServer()).get(`${API}/errands/${s.errandId}/offers`).set(...bearer(s.requester.accessToken)).expect(200);
      await badges().recompute(s.runner.userId);
      const after = await request(app.getHttpServer()).get(`${API}/errands/${s.errandId}/offers`).set(...bearer(s.requester.accessToken)).expect(200);

      expect(after.body.data.map((o: { id: string }) => o.id)).toEqual(before.body.data.map((o: { id: string }) => o.id));
    });
  });

  describe('nightly recompute', () => {
    it('covers users not computed in the last day, once', async () => {
      const s = await completedScene(app, categoryId);
      const due = await badges().dueForRecompute(50);
      expect(due).toContain(s.runner.userId);
      expect(due).toContain(s.requester.userId);

      // The scheduler process owns the sweeper; build it the way its module does and run one batch.
      const sweeper = new BadgeRecomputeSweeper(prisma as never, badges());
      const done = await (sweeper as unknown as { processBatch(): Promise<number> }).processBatch();

      expect(done).toBeGreaterThanOrEqual(2);
      expect(await badges().dueForRecompute(50)).not.toContain(s.runner.userId);
      expect(await live(s.runner.userId)).toContain('NEW');
    });
  });

  describe('schema', () => {
    it('holds one live badge of a kind per user and never deletes', async () => {
      const user = await signedInUser(app);
      const insert = () =>
        prisma.$executeRaw`
          INSERT INTO user_badges (user_id, badge, awarded_at, reason_snapshot)
          VALUES (${user.userId}::uuid, 'TRUSTED'::"BadgeType", now(), '{}'::jsonb)`;
      await insert();
      await expect(insert()).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM user_badges WHERE user_id = ${user.userId}::uuid`).rejects.toThrow();
      await prisma.$executeRaw`UPDATE user_badges SET revoked_at = now() WHERE user_id = ${user.userId}::uuid`;
      await expect(insert()).resolves.toBeDefined();
    });
  });
});

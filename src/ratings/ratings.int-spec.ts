/**
 * P9-01: ratings (Backend PRD 20). Blind reveal, the rating window, edits, aggregates and the
 * public views, over HTTP against real PostgreSQL and Redis.
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
import { acceptAssignment, acceptedScene, completedScene, completeErrand, executionStep, selectRunner } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { RatingService } from './rating.service.js';
import { UserStatsService } from './user-stats.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Ratings (P9-01)', () => {
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
  const rate = (user: Authed, assignmentId: string, body: Record<string, unknown>, key = randomUUID()) =>
    request(app.getHttpServer())
      .post(`${API}/assignments/${assignmentId}/ratings`)
      .set(...bearer(user.accessToken))
      .set('Idempotency-Key', key)
      .send(body);
  const view = (user: Authed, assignmentId: string) =>
    request(app.getHttpServer()).get(`${API}/assignments/${assignmentId}/ratings`).set(...bearer(user.accessToken));
  const edit = (user: Authed, ratingId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).patch(`${API}/ratings/${ratingId}`).set(...bearer(user.accessToken)).send(body);
  const profileRatings = (viewer: Authed, userId: string) =>
    request(app.getHttpServer()).get(`${API}/users/${userId}/ratings`).set(...bearer(viewer.accessToken));
  const publicProfile = (viewer: Authed, userId: string) =>
    request(app.getHttpServer()).get(`${API}/users/${userId}`).set(...bearer(viewer.accessToken));

  /** Another completed errand for the same runner, from a new requester. */
  async function completedFor(runner: Authed) {
    const requester = await signedInUser(app);
    const errandId = await insertErrand({ requesterId: requester.userId, categoryId });
    const offer = (await submitOffer(app, runner, errandId).expect(201)).body.data;
    const selected = await selectRunner(app, requester, errandId, offer.id, offer.version).expect(201);
    const assignmentId = selected.body.data.id as string;
    await acceptAssignment(app, runner, assignmentId).expect(201);
    for (const name of ['start', 'pickup', 'deliver'] as const) {
      await executionStep(app, runner, assignmentId, name).expect(201);
    }
    await completeErrand(app, requester, errandId).expect(201);
    return { requester, errandId, assignmentId };
  }

  describe('eligibility', () => {
    it('is refused until the errand is completed', async () => {
      const s = await acceptedScene(app, categoryId);

      const res = await rate(s.requester, s.assignmentId, { scores: { overall: 5 } });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('RATING_NOT_ELIGIBLE');
      expect(res.body.error.details.reason).toBe('NOT_COMPLETED');
      expect((await view(s.requester, s.assignmentId).expect(200)).body.data).toMatchObject({ canRate: false, reason: 'NOT_COMPLETED' });
    });

    it('is invisible to a stranger, who also cannot rate', async () => {
      const s = await completedScene(app, categoryId);
      const stranger = await signedInUser(app);

      expect((await rate(stranger, s.assignmentId, { scores: { overall: 5 } })).status).toBe(404);
      expect((await view(stranger, s.assignmentId)).status).toBe(404);
    });

    it('needs an overall score and keeps every score within 1 to 5', async () => {
      const s = await completedScene(app, categoryId);

      expect((await rate(s.requester, s.assignmentId, { scores: { reliability: 4 } })).status).toBe(400);
      expect((await rate(s.requester, s.assignmentId, { scores: { overall: 0 } })).status).toBe(400);
      expect((await rate(s.requester, s.assignmentId, { scores: { overall: 6 } })).status).toBe(400);
      expect((await rate(s.requester, s.assignmentId, { scores: { overall: 4.5 } })).status).toBe(400);
      expect((await rate(s.requester, s.assignmentId, { scores: { overall: 5 }, review: 'x'.repeat(1001) })).status).toBe(400);
      expect(await prisma.rating.count()).toBe(0);
    });

    it('allows one rating per party and refuses a second', async () => {
      const s = await completedScene(app, categoryId);
      await rate(s.requester, s.assignmentId, { scores: { overall: 5 } }).expect(201);

      const again = await rate(s.requester, s.assignmentId, { scores: { overall: 1 } });

      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('RATING_ALREADY_SUBMITTED');
      expect(await prisma.rating.count()).toBe(1);
    });

    it('is refused after the window closes', async () => {
      const s = await completedScene(app, categoryId);
      await prisma.$executeRaw`UPDATE assignments SET completed_at = now() - interval '8 days' WHERE id = ${s.assignmentId}::uuid`;

      const res = await rate(s.requester, s.assignmentId, { scores: { overall: 5 } });

      expect(res.status).toBe(403);
      expect(res.body.error.details.reason).toBe('WINDOW_CLOSED');
    });

    it('is refused on a cancelled assignment', async () => {
      const s = await acceptedScene(app, categoryId);
      await request(app.getHttpServer())
        .post(`${API}/assignments/${s.assignmentId}/cancel`)
        .set(...bearer(s.requester.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'REQUESTER_CANCELLED' })
        .expect(200);

      expect((await rate(s.requester, s.assignmentId, { scores: { overall: 5 } })).status).toBe(403);
    });

    it('two identical submits with one idempotency key create one rating', async () => {
      const s = await completedScene(app, categoryId);
      const key = randomUUID();

      const [a, b] = await Promise.all([
        rate(s.requester, s.assignmentId, { scores: { overall: 4 } }, key),
        rate(s.requester, s.assignmentId, { scores: { overall: 4 } }, key),
      ]);

      expect([a.status, b.status].filter((code) => code === 201).length).toBeGreaterThanOrEqual(1);
      expect(await prisma.rating.count()).toBe(1);
    });
  });

  describe('blind reveal (Backend PRD 20.3)', () => {
    it('hides each side until both have rated, then shows both', async () => {
      const s = await completedScene(app, categoryId);

      const first = await rate(s.requester, s.assignmentId, { scores: { overall: 5, communication: 4 }, review: 'Quick and careful' }).expect(201);
      expect(first.body.data).toMatchObject({ revealed: false, editable: true, scores: { overall: 5, communication: 4 } });

      // The runner sees that the requester has rated, not what they said.
      const runnerBefore = (await view(s.runner, s.assignmentId).expect(200)).body.data;
      expect(runnerBefore).toMatchObject({ canRate: true, counterpartRated: true, theirs: null, mine: null });
      expect((await profileRatings(s.requester, s.runner.userId).expect(200)).body.data).toHaveLength(0);

      const second = await rate(s.runner, s.assignmentId, { scores: { overall: 4, paymentConduct: 5 } }).expect(201);
      expect(second.body.data).toMatchObject({ revealed: true, editable: false });

      const runnerAfter = (await view(s.runner, s.assignmentId).expect(200)).body.data;
      expect(runnerAfter.theirs).toMatchObject({ revealed: true, review: 'Quick and careful', scores: { overall: 5, communication: 4 } });
      const requesterAfter = (await view(s.requester, s.assignmentId).expect(200)).body.data;
      expect(requesterAfter.theirs).toMatchObject({ scores: { overall: 4, paymentConduct: 5 } });
      expect((await prisma.rating.findMany()).every((r) => r.revealedAt !== null)).toBe(true);
    });

    it('two parties submitting at the same moment are both revealed', async () => {
      const s = await completedScene(app, categoryId);

      await Promise.all([
        rate(s.requester, s.assignmentId, { scores: { overall: 5 } }).expect(201),
        rate(s.runner, s.assignmentId, { scores: { overall: 3 } }).expect(201),
      ]);

      const rows = await prisma.rating.findMany();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.revealedAt !== null)).toBe(true);
      const revealedEvents = await prisma.outboxEvent.count({ where: { eventType: 'rating.revealed' } });
      expect(revealedEvents).toBe(2);
    });

    it('reveals a lone rating when the window closes, and a rating of an anonymous side stays hidden until then', async () => {
      const s = await completedScene(app, categoryId);
      await rate(s.requester, s.assignmentId, { scores: { overall: 5 } }).expect(201);
      const service = app.get(RatingService);

      expect(await service.revealDue()).toBe(0);
      await prisma.$executeRaw`UPDATE assignments SET completed_at = now() - interval '8 days' WHERE id = ${s.assignmentId}::uuid`;
      expect(await service.revealDue()).toBe(1);
      expect(await service.revealDue()).toBe(0);

      const listed = (await profileRatings(s.runner, s.runner.userId).expect(200)).body.data;
      expect(listed).toHaveLength(1);
      const runnerView = (await view(s.runner, s.assignmentId).expect(200)).body.data;
      expect(runnerView).toMatchObject({ canRate: false, reason: 'WINDOW_CLOSED' });
      expect(runnerView.theirs.scores.overall).toBe(5);
    });

    it('tells the ratee only at the reveal, and never with the scores', async () => {
      const s = await completedScene(app, categoryId);
      await rate(s.requester, s.assignmentId, { scores: { overall: 2 }, review: 'Late' }).expect(201);
      await dispatchOutbox(app, { eventType: ['rating.submitted'] });

      const before = await request(app.getHttpServer()).get(`${API}/notifications`).set(...bearer(s.runner.accessToken)).expect(200);
      expect((before.body.data as Array<{ type: string }>).filter((n) => n.type === 'rating.received')).toHaveLength(0);

      await rate(s.runner, s.assignmentId, { scores: { overall: 5 } }).expect(201);
      await dispatchOutbox(app, { eventType: ['rating.revealed'] });

      const after = await request(app.getHttpServer()).get(`${API}/notifications`).set(...bearer(s.runner.accessToken)).expect(200);
      const notices = (after.body.data as Array<{ type: string; body: string }>).filter((n) => n.type === 'rating.received');
      expect(notices).toHaveLength(1);
      expect(notices[0].body).not.toMatch(/Late|2/);
    });
  });

  describe('edits', () => {
    it('can be changed before the reveal, keeping the previous content', async () => {
      const s = await completedScene(app, categoryId);
      const created = (await rate(s.requester, s.assignmentId, { scores: { overall: 2, timeliness: 2 }, review: 'Slow' }).expect(201)).body.data;

      const changed = await edit(s.requester, created.id, { scores: { overall: 4 }, review: 'Fine in the end' }).expect(200);

      expect(changed.body.data).toMatchObject({ scores: { overall: 4, timeliness: 2 }, review: 'Fine in the end', revealed: false });
      const history = await prisma.ratingEdit.findMany({ where: { ratingId: created.id } });
      expect(history).toHaveLength(1);
      expect(history[0].previous).toMatchObject({ review: 'Slow', scores: { overall: 2, timeliness: 2 } });
    });

    it('is closed once both sides rated (revealed)', async () => {
      const s = await completedScene(app, categoryId);
      const mine = (await rate(s.requester, s.assignmentId, { scores: { overall: 5 } }).expect(201)).body.data;
      await rate(s.runner, s.assignmentId, { scores: { overall: 5 } }).expect(201);

      const res = await edit(s.requester, mine.id, { scores: { overall: 1 } });

      expect(res.status).toBe(403);
      expect(res.body.error.details.reason).toBe('REVEALED');
    });

    it('is closed 24 hours after submission', async () => {
      const s = await completedScene(app, categoryId);
      const mine = (await rate(s.requester, s.assignmentId, { scores: { overall: 5 } }).expect(201)).body.data;
      await prisma.$executeRaw`UPDATE ratings SET editable_until = now() - interval '1 minute' WHERE id = ${mine.id}::uuid`;

      const res = await edit(s.requester, mine.id, { review: 'changed my mind' });

      expect(res.status).toBe(403);
      expect(res.body.error.details.reason).toBe('EDIT_WINDOW_CLOSED');
      expect((await view(s.requester, s.assignmentId).expect(200)).body.data.mine).toMatchObject({ editable: false, editableUntil: null });
    });

    it('can be changed only by its rater', async () => {
      const s = await completedScene(app, categoryId);
      const mine = (await rate(s.requester, s.assignmentId, { scores: { overall: 5 } }).expect(201)).body.data;

      expect((await edit(s.runner, mine.id, { scores: { overall: 1 } })).status).toBe(404);
      expect((await edit(s.requester, mine.id, {})).status).toBe(400);
    });
  });

  describe('aggregates and public views (Backend PRD 20.4)', () => {
    it('counts only revealed ratings and shows an average from three of them', async () => {
      const stats = app.get(UserStatsService);
      const viewer = await signedInUser(app);
      const first = await completedScene(app, categoryId);
      const runner = first.runner;

      // Not revealed yet: in no figure.
      await rate(first.requester, first.assignmentId, { scores: { overall: 5, paymentConduct: 5 } }).expect(201);
      expect((await stats.get(runner.userId)).runner.count).toBe(0);

      await rate(runner, first.assignmentId, { scores: { overall: 4, paymentConduct: 2 } }).expect(201);
      const one = await stats.get(runner.userId);
      expect(one).toMatchObject({ completedAsRunner: 1, runner: { count: 1, average: null } });
      expect((await publicProfile(viewer, runner.userId).expect(200)).body.data.stats.runnerRating).toEqual({ count: 1, average: null });

      // The requester's payment conduct is rated by the runner and shows once there are three.
      expect((await stats.get(first.requester.userId)).paymentConduct).toEqual({ count: 1, average: null });

      for (const overall of [4, 3]) {
        const next = await completedFor(runner);
        await rate(next.requester, next.assignmentId, { scores: { overall } }).expect(201);
        await rate(runner, next.assignmentId, { scores: { overall: 5 } }).expect(201);
      }

      const three = await stats.get(runner.userId);
      expect(three.completedAsRunner).toBe(3);
      expect(three.runner).toEqual({ count: 3, average: 4 });
      const profile = (await publicProfile(viewer, runner.userId).expect(200)).body.data;
      expect(profile.stats.runnerRating).toEqual({ count: 3, average: 4 });
      expect(profile.stats.completedAsRunner).toBe(3);
    });

    it('lists published ratings with the rater as first name and last initial', async () => {
      const s = await completedScene(app, categoryId);
      await rate(s.requester, s.assignmentId, { scores: { overall: 5, reliability: 5 }, review: 'Great' }).expect(201);
      await rate(s.runner, s.assignmentId, { scores: { overall: 4 } }).expect(201);
      const viewer = await signedInUser(app);

      const res = await profileRatings(viewer, s.runner.userId).expect(200);

      expect(res.body.data).toHaveLength(1);
      const [item] = res.body.data;
      expect(item).toMatchObject({ direction: 'REQUESTER_TO_RUNNER', review: 'Great', scores: { overall: 5, reliability: 5 } });
      expect(item.raterLastInitial).toHaveLength(1);
      expect(JSON.stringify(item)).not.toContain(s.requester.userId);
      expect(item).not.toHaveProperty('raterId');
    });

    it('leaves a hidden or removed rating out of every figure and every list', async () => {
      const s = await completedScene(app, categoryId);
      await rate(s.requester, s.assignmentId, { scores: { overall: 1 }, review: 'Rude' }).expect(201);
      await rate(s.runner, s.assignmentId, { scores: { overall: 5 } }).expect(201);
      const stats = app.get(UserStatsService);
      expect((await stats.get(s.runner.userId)).runner.count).toBe(1);

      await prisma.rating.updateMany({ where: { direction: 'REQUESTER_TO_RUNNER' }, data: { status: 'HIDDEN' } });
      await prisma.$transaction((tx) => stats.recompute(tx, s.runner.userId));

      expect((await stats.get(s.runner.userId)).runner.count).toBe(0);
      expect((await profileRatings(s.requester, s.runner.userId).expect(200)).body.data).toHaveLength(0);
      expect((await view(s.runner, s.assignmentId).expect(200)).body.data.theirs).toBeNull();
    });
  });

  describe('schema', () => {
    it('refuses a rating by someone who is not a party, a rating of oneself and a score outside 1 to 5', async () => {
      const s = await completedScene(app, categoryId);
      const stranger = await signedInUser(app);

      await expect(
        prisma.rating.create({
          data: {
            assignmentId: s.assignmentId,
            raterId: stranger.userId,
            rateeId: s.runner.userId,
            direction: 'REQUESTER_TO_RUNNER',
            editableUntil: new Date(Date.now() + 3_600_000),
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`
          INSERT INTO ratings (assignment_id, rater_id, ratee_id, direction, editable_until, updated_at)
          VALUES (${s.assignmentId}::uuid, ${s.requester.userId}::uuid, ${s.requester.userId}::uuid, 'REQUESTER_TO_RUNNER', now(), now())
        `,
      ).rejects.toThrow();

      const mine = (await rate(s.requester, s.assignmentId, { scores: { overall: 5 } }).expect(201)).body.data;
      await expect(
        prisma.$executeRaw`UPDATE rating_scores SET score = 9 WHERE rating_id = ${mine.id}::uuid`,
      ).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM rating_scores WHERE rating_id = ${mine.id}::uuid`).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM ratings WHERE id = ${mine.id}::uuid`).rejects.toThrow();
    });
  });
});

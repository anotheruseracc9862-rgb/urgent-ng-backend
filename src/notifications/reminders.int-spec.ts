/**
 * P8-05: scheduled reminders. Each fires once and respects preferences. Deadlines are database
 * columns, so tests move time by rewriting them.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { insertErrand, seedCategories } from '../test/errand.helper.js';
import { acceptedScene, executionStep, completeErrand, selectedScene } from '../test/assignment.helper.js';
import { ReminderService } from './reminder.service.js';
import { NotificationPreferenceService } from '../auth/notification-preference.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Reminders (P8-05)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categoryId: string;
  const reminders = () => app.get(ReminderService);

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
  const ofType = async (user: Authed, type: string) =>
    ((await request(app.getHttpServer()).get(`${API}/notifications`).set(...bearer(user.accessToken)).expect(200)).body.data as Array<{ type: string; body: string }>).filter(
      (n) => n.type === type,
    );

  describe('acceptance deadline warning', () => {
    it('warns the selected runner shortly before the window ends, once', async () => {
      const s = await selectedScene(app, categoryId);
      await prisma.$executeRaw`UPDATE assignments SET acceptance_deadline = now() + interval '5 minutes' WHERE id = ${s.assignmentId}::uuid`;

      const first = await reminders().run();
      const second = await reminders().run();

      expect(first.acceptanceWarnings).toBe(1);
      expect(second.acceptanceWarnings).toBe(0);
      const notices = await ofType(s.runner, 'assignment.acceptance_warning');
      expect(notices).toHaveLength(1);
      expect(notices[0].body).toMatch(/until \d{2}:\d{2}/);
      expect(await ofType(s.requester, 'assignment.acceptance_warning')).toHaveLength(0);
    });

    it('does not warn early, after the deadline, or once accepted', async () => {
      const early = await selectedScene(app, categoryId);
      const late = await selectedScene(app, categoryId);
      const done = await selectedScene(app, categoryId);
      await prisma.$executeRaw`UPDATE assignments SET acceptance_deadline = now() + interval '25 minutes' WHERE id = ${early.assignmentId}::uuid`;
      await prisma.$executeRaw`UPDATE assignments SET acceptance_deadline = now() - interval '1 minute' WHERE id = ${late.assignmentId}::uuid`;
      await prisma.$executeRaw`UPDATE assignments SET acceptance_deadline = now() + interval '5 minutes' WHERE id = ${done.assignmentId}::uuid`;
      await request(app.getHttpServer()).post(`${API}/assignments/${done.assignmentId}/accept`).set(...bearer(done.runner.accessToken)).set('Idempotency-Key', 'accept-key-12345').send({}).expect(201);

      const counts = await reminders().run();

      expect(counts.acceptanceWarnings).toBe(0);
    });

    it('is a mandatory notice: switching marketplace notices off does not hide it', async () => {
      const s = await selectedScene(app, categoryId);
      await app.get(NotificationPreferenceService).set(s.runner.userId, [{ category: 'MARKETPLACE', channel: 'IN_APP', enabled: false }]);
      await prisma.$executeRaw`UPDATE assignments SET acceptance_deadline = now() + interval '5 minutes' WHERE id = ${s.assignmentId}::uuid`;

      await reminders().run();

      expect(await ofType(s.runner, 'assignment.acceptance_warning')).toHaveLength(1);
    });
  });

  describe('errand expiring', () => {
    it('warns the requester shortly before an open errand closes, once per deadline', async () => {
      const requester = await signedInUser(app);
      const soon = await insertErrand({ requesterId: requester.userId, categoryId });
      const later = await insertErrand({ requesterId: requester.userId, categoryId });
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() + interval '30 minutes' WHERE id = ${soon}::uuid`;
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() + interval '5 hours' WHERE id = ${later}::uuid`;

      expect((await reminders().run()).errandExpiring).toBe(1);
      expect((await reminders().run()).errandExpiring).toBe(0);

      const notices = await ofType(requester, 'errand.expiring');
      expect(notices).toHaveLength(1);
      expect(notices[0].body).toMatch(/closes at \d{2}:\d{2}/);

      // Extended: a new deadline may warn again.
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() + interval '40 minutes' WHERE id = ${soon}::uuid`;
      expect((await reminders().run()).errandExpiring).toBe(1);
    });

    it('does not warn about errands that are no longer open, or when the notice is switched off', async () => {
      const requester = await signedInUser(app);
      const taken = await insertErrand({ requesterId: requester.userId, categoryId, status: 'CANCELLED' });
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() + interval '10 minutes' WHERE id = ${taken}::uuid`;
      expect((await reminders().run()).errandExpiring).toBe(0);

      const open = await insertErrand({ requesterId: requester.userId, categoryId });
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() + interval '10 minutes' WHERE id = ${open}::uuid`;
      await app.get(NotificationPreferenceService).set(requester.userId, [{ category: 'MARKETPLACE', channel: 'IN_APP', enabled: false }]);

      await reminders().run();

      expect(await ofType(requester, 'errand.expiring')).toHaveLength(0);
    });
  });

  describe('rating reminders', () => {
    async function completed(hoursAgo: number) {
      const s = await acceptedScene(app, categoryId);
      for (const name of ['start', 'pickup', 'deliver'] as const) {
        await executionStep(app, s.runner, s.assignmentId, name).expect(201);
      }
      await completeErrand(app, s.requester, s.errandId).expect(201);
      await prisma.$executeRawUnsafe(
        `UPDATE assignments SET completed_at = now() - interval '${hoursAgo} hours' WHERE id = $1::uuid`,
        s.assignmentId,
      );
      return s;
    }

    it('go to both parties at 24 hours and at 72 hours, each once', async () => {
      const day = await completed(25);
      const days = await completed(73);
      const fresh = await completed(2);

      const first = await reminders().run();
      const second = await reminders().run();

      expect(first.ratingReminders).toBe(4);
      expect(second.ratingReminders).toBe(0);
      for (const user of [day.requester, day.runner, days.requester, days.runner]) {
        expect(await ofType(user, 'rating.reminder'), user.userId).toHaveLength(1);
      }
      expect(await ofType(fresh.requester, 'rating.reminder')).toHaveLength(0);
      const keys = (await prisma.notification.findMany({ where: { type: 'rating.reminder' } })).map((n) => n.dedupeKey);
      expect(keys.filter((k) => k?.includes(':24h:'))).toHaveLength(2);
      expect(keys.filter((k) => k?.includes(':72h:'))).toHaveLength(2);
    });

    it('a reminder from a later band is sent when the earlier one has not been due for long', async () => {
      const s = await completed(25);
      await reminders().run();
      await prisma.$executeRawUnsafe(`UPDATE assignments SET completed_at = now() - interval '73 hours' WHERE id = $1::uuid`, s.assignmentId);

      const counts = await reminders().run();

      expect(counts.ratingReminders).toBe(2);
      expect(await ofType(s.requester, 'rating.reminder')).toHaveLength(2);
    });

    it('respects the preference: marketplace notices off means no reminder', async () => {
      const s = await completed(25);
      await app.get(NotificationPreferenceService).set(s.requester.userId, [{ category: 'MARKETPLACE', channel: 'IN_APP', enabled: false }]);

      await reminders().run();

      expect(await ofType(s.requester, 'rating.reminder')).toHaveLength(0);
      expect(await ofType(s.runner, 'rating.reminder')).toHaveLength(1);
    });

    it('stops after the rating window', async () => {
      await completed(24 * 8);
      expect((await reminders().run()).ratingReminders).toBe(0);
    });
  });
});

/**
 * P11-03: errands, offers and assignments. No admin endpoint writes a status column directly: every
 * change goes through the state machine with actor ADMIN.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, adminLogin, bearer, createAdmin, seedAdminRoles, seedPolicies, signedInUser, type TestAdmin } from '../test/auth.helper.js';
import { insertErrand, seedCategories } from '../test/errand.helper.js';
import { acceptedScene, executionStep, offerScene, selectedScene } from '../test/assignment.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Admin API: errands, offers, assignments (P11-03)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categories: Record<string, string>;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    await seedAdminRoles();
    categories = await seedCategories();
  });
  afterAll(async () => {
    await app.close();
  });

  const as = (admin: TestAdmin) => ({
    get: (path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(admin.accessToken as string)),
    post: (path: string, body: Record<string, unknown> = {}) =>
      request(app.getHttpServer()).post(`${API}${path}`).set(...bearer(admin.accessToken as string)).send(body),
  });
  const login = async (role: string) => adminLogin(app, await createAdmin(app, { roles: [role] }));
  const reason = { reasonCode: 'POLICY_VIOLATION', reasonText: 'Test reason' };
  const statusOf = async (errandId: string) =>
    (await prisma.$queryRaw<Array<{ status: string }>>`SELECT status::text FROM errands WHERE id = ${errandId}::uuid`)[0].status;

  describe('errands', () => {
    it('searches by title, status and requester, and shows the detail and timeline', async () => {
      const support = as(await login('SUPPORT_AGENT'));
      const requester = await signedInUser(app, { name: 'Zainab Bello' });
      const open = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery, title: 'Collect the generator' });
      await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery, title: 'Old parcel', status: 'COMPLETED' });

      const byTitle = (await support.get('/admin/errands?q=generator').expect(200)).body.data;
      expect(byTitle.map((e: { id: string }) => e.id)).toEqual([open]);
      expect((await support.get('/admin/errands?status=COMPLETED').expect(200)).body.data).toHaveLength(1);
      expect((await support.get('/admin/errands?q=zainab').expect(200)).body.data).toHaveLength(2);

      const detail = (await support.get(`/admin/errands/${open}`).expect(200)).body.data;
      expect(detail).toMatchObject({ id: open, status: 'OPEN', requester: { name: 'Zainab Bello' } });
      expect(detail.locations[0]).toMatchObject({ type: 'ERRAND_PICKUP', area: 'Yaba' });
      expect(Array.isArray((await support.get(`/admin/errands/${open}/timeline`).expect(200)).body.data)).toBe(true);
      await support.get('/admin/errands/00000000-0000-4000-8000-000000000000').expect(404);
    });

    it('shows exact locations only with LOCATION_EXACT_VIEW, and records the view', async () => {
      const support = as(await login('SUPPORT_AGENT'));
      const root = as(await login('SUPER_ADMIN'));
      const requester = await signedInUser(app);
      const errand = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery });

      await support.get(`/admin/errands/${errand}/locations`).expect(403);
      const res = await root.get(`/admin/errands/${errand}/locations`).expect(200);

      expect(res.body.data[0]).toMatchObject({ type: 'ERRAND_PICKUP', lat: expect.any(Number) });
      expect(await prisma.auditLog.count({ where: { action: 'admin.sensitive_view', entityId: errand } })).toBe(1);
    });

    it('force cancels an open errand with a reason, closing its offers, and refuses without permission or reason', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const support = as(await login('SUPPORT_AGENT'));
      const s = await offerScene(app, categories.delivery);

      await support.post(`/admin/errands/${s.errandId}/cancel`, reason).expect(403);
      await trust.post(`/admin/errands/${s.errandId}/cancel`, {}).expect(400);
      const res = await trust.post(`/admin/errands/${s.errandId}/cancel`, reason).expect(200);

      expect(res.body.data).toMatchObject({ from: 'OPEN', to: 'CANCELLED' });
      expect(await statusOf(s.errandId)).toBe('CANCELLED');
      const offer = await prisma.offer.findUniqueOrThrow({ where: { id: s.offerId } });
      expect(offer).toMatchObject({ status: 'CLOSED', closeReason: 'ERRAND_CANCELLED' });
      const history = await prisma.errandStatusHistory.findFirstOrThrow({ where: { errandId: s.errandId, toStatus: 'CANCELLED' } });
      expect(history).toMatchObject({ actorType: 'ADMIN', reason: 'Test reason' });
      const row = await prisma.errand.findUniqueOrThrow({ where: { id: s.errandId } });
      expect(row.cancellationReason).toBe('ADMIN_CANCELLED');
    });

    it('force expires an open errand and reopens an expired or cancelled one with a new deadline', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const requester = await signedInUser(app);
      const errand = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery });

      await trust.post(`/admin/errands/${errand}/expire`, reason).expect(200);
      expect(await statusOf(errand)).toBe('EXPIRED');
      await trust.post(`/admin/errands/${errand}/expire`, reason).expect(409);
      await prisma.$executeRaw`UPDATE errands SET expires_at = now() - interval '2 days' WHERE id = ${errand}::uuid`;

      const reopened = await trust.post(`/admin/errands/${errand}/reopen`, reason).expect(200);
      expect(reopened.body.data.to).toBe('OPEN');
      const row = await prisma.errand.findUniqueOrThrow({ where: { id: errand } });
      expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now());

      await trust.post(`/admin/errands/${errand}/cancel`, reason).expect(200);
      await trust.post(`/admin/errands/${errand}/reopen`, reason).expect(200);
      expect(await statusOf(errand)).toBe('OPEN');
    });

    it('refuses a move the state machine does not allow an admin', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const requester = await signedInUser(app);
      const errand = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery });

      const res = await trust.post(`/admin/errands/${errand}/transition`, { ...reason, to: 'COMPLETED' }).expect(409);

      expect(res.body.error.code).toBe('ERRAND_INVALID_STATE');
      expect(await statusOf(errand)).toBe('OPEN');
    });

    it('extends an open errand by hours, and not an ended one', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const requester = await signedInUser(app);
      const errand = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery, expiresInHours: 2 });
      const before = (await prisma.errand.findUniqueOrThrow({ where: { id: errand } })).expiresAt!;

      const res = await trust.post(`/admin/errands/${errand}/extend`, { ...reason, hours: 6 }).expect(200);

      expect(new Date(res.body.data.expiresAt).getTime()).toBeGreaterThanOrEqual(before.getTime() + 6 * 3_600_000 - 1000);
      await trust.post(`/admin/errands/${errand}/extend`, { ...reason, hours: 500 }).expect(400);
      await trust.post(`/admin/errands/${errand}/cancel`, reason).expect(200);
      await trust.post(`/admin/errands/${errand}/extend`, { ...reason, hours: 2 }).expect(409);
    });

    it('takes an errand down as content, through the state machine', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const support = as(await login('SUPPORT_AGENT'));
      const requester = await signedInUser(app);
      const errand = await insertErrand({ requesterId: requester.userId, categoryId: categories.delivery });

      await support.post(`/admin/errands/${errand}/remove-content`, reason).expect(403);
      await trust.post(`/admin/errands/${errand}/remove-content`, reason).expect(200);

      expect(await statusOf(errand)).toBe('CANCELLED');
    });
  });

  describe('offers', () => {
    it('lists the offers of an errand, shows the history, and closes one', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const support = as(await login('SUPPORT_AGENT'));
      const s = await offerScene(app, categories.delivery);

      const list = (await support.get(`/admin/errands/${s.errandId}/offers`).expect(200)).body.data;
      expect(list.map((o: { id: string }) => o.id)).toEqual([s.offerId]);
      const history = (await support.get(`/admin/offers/${s.offerId}`).expect(200)).body.data;
      expect(history.history.length).toBeGreaterThan(0);

      await support.post(`/admin/offers/${s.offerId}/close`, reason).expect(403);
      const closed = await trust.post(`/admin/offers/${s.offerId}/close`, reason).expect(200);
      expect(closed.body.data).toMatchObject({ status: 'CLOSED', closeReason: 'ADMIN_CLOSED' });
      await trust.post(`/admin/offers/${s.offerId}/close`, reason).expect(409);
    });
  });

  describe('assignments', () => {
    it('lists and shows an assignment with its execution record', async () => {
      const support = as(await login('SUPPORT_AGENT'));
      const s = await acceptedScene(app, categories.delivery);
      await executionStep(app, s.runner, s.assignmentId, 'start').expect(201);

      const list = (await support.get('/admin/assignments?status=ACCEPTED').expect(200)).body.data;
      expect(list.map((a: { id: string }) => a.id)).toEqual([s.assignmentId]);
      const detail = (await support.get(`/admin/assignments/${s.assignmentId}`).expect(200)).body.data;

      expect(detail).toMatchObject({ id: s.assignmentId, status: 'ACCEPTED', errand: { id: s.errandId } });
      expect(detail.events.map((e: { type: string }) => e.type)).toContain('STARTED');
    });

    it('cancels an assignment in progress, and answers a pickup with the dispute route', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const started = await acceptedScene(app, categories.delivery);
      await executionStep(app, started.runner, started.assignmentId, 'start').expect(201);

      await trust.post(`/admin/assignments/${started.assignmentId}/cancel`, reason).expect(200);
      expect(await statusOf(started.errandId)).toBe('CANCELLED');
      const assignment = await prisma.assignment.findUniqueOrThrow({ where: { id: started.assignmentId } });
      expect(assignment.status).toBe('CANCELLED');

      const picked = await acceptedScene(app, categories.delivery);
      await executionStep(app, picked.runner, picked.assignmentId, 'start').expect(201);
      await executionStep(app, picked.runner, picked.assignmentId, 'pickup').expect(201);
      await trust.post(`/admin/assignments/${picked.assignmentId}/cancel`, reason).expect(409);
    });

    it('releases an accepted assignment back to open', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const s = await acceptedScene(app, categories.delivery);

      const res = await trust.post(`/admin/assignments/${s.assignmentId}/release`, reason).expect(200);

      expect(res.body.data).toMatchObject({ from: 'ACCEPTED', to: 'OPEN' });
      expect(await statusOf(s.errandId)).toBe('OPEN');
      const pending = await selectedScene(app, categories.delivery);
      await trust.post(`/admin/assignments/${pending.assignmentId}/release`, reason).expect(409);
    });
  });

  it('writes no status column directly: the admin API sources hold no UPDATE of an errand or assignment status', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts') && !name.endsWith('.int-spec.ts')) files.push(full);
      }
    };
    walk(join(process.cwd(), 'src', 'admin-api'));

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/UPDATE\s+errands\b/i);
      expect(text, file).not.toMatch(/UPDATE\s+assignments\b/i);
      expect(text, file).not.toMatch(/errand\.update\(|assignment\.update\(/);
    }
  });
});

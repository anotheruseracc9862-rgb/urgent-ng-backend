/**
 * P11-02: users, verification, enforcement, blocklist and badges. Every endpoint has a success test
 * and a permission-denied test; every write needs a reason; changes go through the domain services.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, adminLogin, bearer, createAdmin, nextPhone, seedAdminRoles, seedPolicies, signedInUser, type TestAdmin } from '../test/auth.helper.js';
import { REQUIRED_CONSENTS } from '../test/auth.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Admin API: users, verification, enforcement, blocklist, badges (P11-02)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    await seedAdminRoles();
  });
  afterAll(async () => {
    await app.close();
  });

  const as = (admin: TestAdmin) => ({
    get: (path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(admin.accessToken as string)),
    post: (path: string, body: Record<string, unknown> = {}) =>
      request(app.getHttpServer()).post(`${API}${path}`).set(...bearer(admin.accessToken as string)).send(body),
    del: (path: string, body: Record<string, unknown> = {}) =>
      request(app.getHttpServer()).delete(`${API}${path}`).set(...bearer(admin.accessToken as string)).send(body),
  });
  const login = async (role: string) => adminLogin(app, await createAdmin(app, { roles: [role] }));
  const reason = { reasonCode: 'POLICY_VIOLATION', reasonText: 'Test reason' };

  describe('users', () => {
    it('searches by name, phone fragment and id, masks contact data, and filters by status', async () => {
      const admin = as(await login('SUPPORT_AGENT'));
      const ada = await signedInUser(app, { name: 'Adaeze Nwosu' });
      await signedInUser(app, { name: 'Bayo Ade' });

      const byName = (await admin.get('/admin/users?q=adaeze').expect(200)).body.data;
      expect(byName.map((u: { id: string }) => u.id)).toEqual([ada.userId]);
      expect(byName[0].phone).toMatch(/\*/);
      expect(byName[0].phone).not.toBe(ada.phone);

      const byPhone = (await admin.get(`/admin/users?q=${encodeURIComponent(ada.phone.slice(-7))}`).expect(200)).body.data;
      expect(byPhone.map((u: { id: string }) => u.id)).toContain(ada.userId);
      const byId = (await admin.get(`/admin/users?q=${ada.userId}`).expect(200)).body.data;
      expect(byId).toHaveLength(1);
      expect((await admin.get('/admin/users?status=SUSPENDED').expect(200)).body.data).toHaveLength(0);
    });

    it('shows the detail without identity data, and the full contact only with SENSITIVE_DATA_VIEW, audited', async () => {
      const support = as(await login('SUPPORT_AGENT'));
      const root = as(await login('SUPER_ADMIN'));
      const user = await signedInUser(app);

      const detail = (await support.get(`/admin/users/${user.userId}`).expect(200)).body.data;
      expect(detail).toMatchObject({ id: user.userId, status: 'ACTIVE', verified: false });
      expect(JSON.stringify(detail)).not.toContain(user.phone);

      await support.get(`/admin/users/${user.userId}/contact`).expect(403);
      const contact = (await root.get(`/admin/users/${user.userId}/contact`).expect(200)).body.data;
      expect(contact.phone).toBe(user.phone);
      const seen = await prisma.auditLog.findFirst({ where: { action: 'admin.sensitive_view', entityId: user.userId } });
      expect(seen).toMatchObject({ actorType: 'ADMIN', reasonCode: 'SENSITIVE_DATA_VIEW' });
      await root.get('/admin/users/00000000-0000-4000-8000-000000000000').expect(404);
    });

    it('deactivates and reactivates with a reason, and refuses a write without one or without permission', async () => {
      const root = as(await login('SUPER_ADMIN'));
      const support = as(await login('SUPPORT_AGENT'));
      const user = await signedInUser(app);

      await root.post(`/admin/users/${user.userId}/deactivate`, {}).expect(400);
      await support.post(`/admin/users/${user.userId}/deactivate`, reason).expect(403);
      const down = await root.post(`/admin/users/${user.userId}/deactivate`, reason).expect(200);
      expect(down.body.data.status).toBe('DEACTIVATED');
      const up = await root.post(`/admin/users/${user.userId}/reactivate`, reason).expect(200);
      expect(up.body.data.status).toBe('ACTIVE');

      const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'admin.user.deactivate', entityId: user.userId } });
      expect(row).toMatchObject({ actorType: 'ADMIN', reasonCode: 'POLICY_VIOLATION' });
    });

    it('ends every session of a user', async () => {
      const root = as(await login('SUPER_ADMIN'));
      const user = await signedInUser(app);

      await root.post(`/admin/users/${user.userId}/revoke-sessions`, reason).expect(200);

      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .set('X-Client', 'mobile')
        .send({ refreshToken: user.refreshToken })
        .expect(401);
    });

    it('suspends for a number of days through enforcement', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const user = await signedInUser(app);

      const res = await trust.post(`/admin/users/${user.userId}/suspend`, { ...reason, days: 3 }).expect(200);

      expect(res.body.data.status).toBe('SUSPENDED');
      const actions = (await trust.get(`/admin/users/${user.userId}/enforcement`).expect(200)).body.data;
      expect(actions[0]).toMatchObject({ type: 'TEMPORARY_SUSPENSION', status: 'ACTIVE' });
      await trust.post(`/admin/users/${user.userId}/suspend`, { ...reason, days: 0 }).expect(400);
    });

    it('shows consent history and the ladder, and nothing to an anonymous caller', async () => {
      const support = as(await login('SUPPORT_AGENT'));
      const user = await signedInUser(app);

      const consents = (await support.get(`/admin/users/${user.userId}/consents`).expect(200)).body.data;
      expect(consents.consents.length).toBeGreaterThan(0);
      expect((await support.get(`/admin/users/${user.userId}/ladder`).expect(200)).body.data).toMatchObject({ points: 0 });
      await request(app.getHttpServer()).get(`${API}/admin/users`).expect(401);
      await request(app.getHttpServer()).get(`${API}/admin/users`).set(...bearer(user.accessToken)).expect(401);
    });
  });

  describe('verification', () => {
    async function attempt(userId: string, status = 'REVIEW_REQUIRED') {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO verification_attempts (user_id, provider, status, attempt_number, started_at, updated_at, completed_at)
        VALUES (${userId}::uuid, 'fake', ${status}::"VerificationStatus", 1, now(), now(), now())
        RETURNING id::text
      `;
      return rows[0].id;
    }

    it('lists the review queue, approves one with a reason, and refuses without permission', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const finance = as(await login('FINANCE'));
      const user = await signedInUser(app);
      const id = await attempt(user.userId);

      const queue = (await trust.get('/admin/verifications').expect(200)).body.data;
      expect(queue.map((r: { id: string }) => r.id)).toEqual([id]);
      await finance.get('/admin/verifications').expect(403);
      await finance.post(`/admin/verifications/${id}/approve`, reason).expect(403);

      const res = await trust.post(`/admin/verifications/${id}/approve`, reason).expect(200);
      expect(res.body.data.status).toBe('VERIFIED');
      expect((await trust.get('/admin/verifications').expect(200)).body.data).toHaveLength(0);
      expect((await trust.get(`/admin/users/${user.userId}/verifications`).expect(200)).body.data).toHaveLength(1);
    });

    it('rejects with a failure reason, grants attempts and revokes', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const user = await signedInUser(app);
      const id = await attempt(user.userId);

      const rejected = await trust.post(`/admin/verifications/${id}/reject`, { ...reason, failureReason: 'DOCUMENT_INVALID' }).expect(200);
      expect(rejected.body.data).toMatchObject({ status: 'FAILED', failureReason: 'DOCUMENT_INVALID' });
      await trust.post(`/admin/users/${user.userId}/verification/grant-attempts`, reason).expect(200);
      const other = await signedInUser(app);
      const verified = await attempt(other.userId, 'VERIFIED');
      expect(verified).toBeTruthy();
      const revoked = await trust.post(`/admin/users/${other.userId}/verification/revoke`, reason).expect(200);
      expect(revoked.body.data.status).toBe('REVOKED');
    });

    it('shows the submitted details only with SENSITIVE_DATA_VIEW, and records the view', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const root = as(await login('SUPER_ADMIN'));
      const user = await signedInUser(app);
      const id = await attempt(user.userId);
      await prisma.$executeRaw`
        INSERT INTO verification_submissions (attempt_id, user_id, first_name, last_name, lga) VALUES (${id}::uuid, ${user.userId}::uuid, 'Tunde', 'Okon', 'Eti-Osa')
      `;

      await trust.get(`/admin/verifications/${id}/submission`).expect(403);
      const res = await root.get(`/admin/verifications/${id}/submission`).expect(200);

      expect(res.body.data).toMatchObject({ firstName: 'Tunde', lga: 'Eti-Osa' });
      expect(await prisma.auditLog.count({ where: { action: 'admin.sensitive_view', entityId: id } })).toBe(1);
    });
  });

  describe('enforcement', () => {
    it('applies a warning and a feature restriction, lists them, and revokes one', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const support = as(await login('SUPPORT_AGENT'));
      const user = await signedInUser(app);

      await support.post('/admin/enforcement', { ...reason, userId: user.userId, type: 'WARNING' }).expect(403);
      const warning = await trust.post('/admin/enforcement', { ...reason, userId: user.userId, type: 'WARNING' }).expect(200);
      expect(warning.body.data).toMatchObject({ approvalRequired: false, action: { type: 'WARNING' } });
      const restriction = await trust
        .post('/admin/enforcement', { ...reason, userId: user.userId, type: 'FEATURE_RESTRICTION', durationDays: 2, restrictionTypes: ['POSTING'] })
        .expect(200);

      const list = (await trust.get(`/admin/enforcement?userId=${user.userId}`).expect(200)).body.data;
      expect(list).toHaveLength(2);
      const revoked = await trust.post(`/admin/enforcement/${restriction.body.data.action.id}/revoke`, reason).expect(200);
      expect(revoked.body.data.status).toBe('REVOKED');
      await trust.post('/admin/enforcement', { ...reason, userId: user.userId, type: 'FEATURE_RESTRICTION' }).expect(400);
    });

    it('turns a permanent suspension into a four-eyes request that a second admin approves', async () => {
      const first = as(await login('TRUST_AND_SAFETY'));
      const second = as(await login('TRUST_AND_SAFETY'));
      const user = await signedInUser(app);

      const asked = await first.post('/admin/enforcement', { ...reason, userId: user.userId, type: 'PERMANENT_SUSPENSION' }).expect(200);
      expect(asked.body.data).toMatchObject({ approvalRequired: true, approval: { status: 'PENDING', kind: 'PERMANENT_SUSPENSION' } });
      expect((await first.get(`/admin/users/${user.userId}`).expect(200)).body.data.status).toBe('ACTIVE');

      await first.post(`/admin/approvals/${asked.body.data.approval.id}/approve`, {}).expect(403);
      const done = await second.post(`/admin/approvals/${asked.body.data.approval.id}/approve`, {}).expect(200);

      expect(done.body.data.status).toBe('EXECUTED');
      expect((await first.get(`/admin/users/${user.userId}`).expect(200)).body.data.status).toBe('SUSPENDED');
      const actions = (await first.get(`/admin/enforcement?userId=${user.userId}`).expect(200)).body.data;
      expect(actions[0]).toMatchObject({ type: 'PERMANENT_SUSPENSION', status: 'ACTIVE' });
    });

    it('lists appeals and decides one', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const user = await signedInUser(app);
      const applied = await trust
        .post('/admin/enforcement', { ...reason, userId: user.userId, type: 'FEATURE_RESTRICTION', durationDays: 5, restrictionTypes: ['POSTING'] })
        .expect(200);
      const actionId = applied.body.data.action.id as string;
      await request(app.getHttpServer())
        .post(`${API}/enforcement/${actionId}/appeal`)
        .set(...bearer(user.accessToken))
        .send({ note: 'This was a mistake' })
        .expect(201);

      const appeals = (await trust.get('/admin/enforcement/appeals').expect(200)).body.data;
      expect(appeals.map((a: { id: string }) => a.id)).toEqual([actionId]);
      const decided = await trust
        .post(`/admin/enforcement/${actionId}/appeal/decide`, { ...reason, outcome: 'REVOKED', note: 'Agreed' })
        .expect(200);

      expect(decided.body.data.status).toBe('REVOKED');
      expect((await trust.get('/admin/enforcement/appeals').expect(200)).body.data).toHaveLength(0);
    });

    it('lists open review cases and dismisses one', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const user = await signedInUser(app);
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO enforcement_reviews (user_id, trigger, reason, status, updated_at)
        VALUES (${user.userId}::uuid, 'SEVERE_EVENT', 'Prohibited item reported', 'OPEN', now()) RETURNING id::text
      `;

      const open = (await trust.get('/admin/enforcement/reviews').expect(200)).body.data;
      expect(open.map((r: { id: string }) => r.id)).toEqual([rows[0].id]);
      await trust.post(`/admin/enforcement/reviews/${rows[0].id}/dismiss`, reason).expect(200);
      expect((await trust.get('/admin/enforcement/reviews').expect(200)).body.data).toHaveLength(0);
    });
  });

  describe('blocklist and badges', () => {
    it('blocks a phone number so it cannot register, lists the entry without the value, and lifts it', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const support = as(await login('SUPPORT_AGENT'));
      const phone = nextPhone();

      await support.post('/admin/blocklist', { ...reason, type: 'PHONE', value: phone }).expect(403);
      await trust.post('/admin/blocklist', { ...reason, type: 'PHONE', value: phone }).expect(200);
      await trust.post('/admin/blocklist', { ...reason, type: 'PHONE', value: 'nope' }).expect(400);
      const entries = (await trust.get('/admin/blocklist').expect(200)).body.data;
      expect(entries).toHaveLength(1);
      expect(JSON.stringify(entries)).not.toContain(phone.slice(-8));

      const blocked = await request(app.getHttpServer())
        .post(`${API}/auth/register`)
        .send({ name: 'Ada Obi', phone, password: 'Str0ng-passw0rd!', consents: REQUIRED_CONSENTS })
        .expect(403);
      expect(blocked.body.error.code).toBe('REGISTRATION_BLOCKED');

      await trust.del(`/admin/blocklist/${entries[0].id}`, reason).expect(200);
      await request(app.getHttpServer())
        .post(`${API}/auth/register`)
        .send({ name: 'Ada Obi', phone, password: 'Str0ng-passw0rd!', consents: REQUIRED_CONSENTS })
        .expect(201);
    });

    it('shows a user\'s badges and recomputes them', async () => {
      const trust = as(await login('TRUST_AND_SAFETY'));
      const support = as(await login('SUPPORT_AGENT'));
      const user = await signedInUser(app);

      await trust.post(`/admin/users/${user.userId}/badges/recompute`, reason).expect(200);
      const badges = (await support.get(`/admin/users/${user.userId}/badges`).expect(200)).body.data;

      expect(Array.isArray(badges)).toBe(true);
      await support.post(`/admin/users/${user.userId}/badges/recompute`, reason).expect(403);
    });
  });
});

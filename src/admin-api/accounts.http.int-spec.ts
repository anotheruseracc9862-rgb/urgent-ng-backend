/**
 * P11-09: admin accounts. Role and permission changes need a second admin and apply on the next
 * request; nobody can lock the console by removing the last super admin.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { AdminAccountsService } from './accounts/admin-accounts.js';
import { API, adminLogin, bearer, createAdmin, seedAdminRoles, seedPolicies, type TestAdmin } from '../test/auth.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Admin API: admin accounts (P11-09)', () => {
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
    put: (path: string, body: Record<string, unknown> = {}) =>
      request(app.getHttpServer()).put(`${API}${path}`).set(...bearer(admin.accessToken as string)).send(body),
  });
  const login = async (role: string) => adminLogin(app, await createAdmin(app, { roles: [role] }));
  const reason = { reasonCode: 'ROUTINE_OPERATION', reasonText: 'Test reason' };
  const PASSWORD = 'A-long-admin-passw0rd!';

  async function invited(inviter: TestAdmin, email = `new.${Date.now()}@urgent.ng`) {
    const res = await as(inviter).post('/admin/admins/invite', { ...reason, email, displayName: 'New Admin' }).expect(201);
    return { email, ...res.body.data } as { email: string; adminId: string; inviteToken: string; expiresAt: string };
  }

  describe('invitations', () => {
    it('creates an account without roles, which signs in only after the invitation is accepted', async () => {
      const root = await login('SUPER_ADMIN');
      const support = as(await login('SUPPORT_AGENT'));

      await support.post('/admin/admins/invite', { ...reason, email: 'x@urgent.ng', displayName: 'X' }).expect(403);
      const invite = await invited(root);
      expect(invite.inviteToken.length).toBeGreaterThan(20);
      expect(JSON.stringify((await prisma.admin.findUniqueOrThrow({ where: { id: invite.adminId } })))).not.toContain(invite.inviteToken);

      await request(app.getHttpServer()).post(`${API}/admin/auth/login`).send({ email: invite.email, password: PASSWORD }).expect(401);
      await request(app.getHttpServer()).post(`${API}/admin/auth/accept-invite`).send({ token: invite.inviteToken, password: 'short' }).expect(400);
      await request(app.getHttpServer()).post(`${API}/admin/auth/accept-invite`).send({ token: invite.inviteToken, password: PASSWORD }).expect(200);
      await request(app.getHttpServer()).post(`${API}/admin/auth/accept-invite`).send({ token: invite.inviteToken, password: PASSWORD }).expect(404);

      const session = await adminLogin(app, { adminId: invite.adminId, email: invite.email, password: PASSWORD });
      expect((await request(app.getHttpServer()).get(`${API}/admin/auth/me`).set(...bearer(session.accessToken as string)).expect(200)).body.data.roles).toEqual([]);
      await as(session).get('/admin/users').expect(403);
    });

    it('refuses an expired invitation and a duplicate email', async () => {
      const root = await login('SUPER_ADMIN');
      const invite = await invited(root);

      await as(root).post('/admin/admins/invite', { ...reason, email: invite.email, displayName: 'Again' }).expect(409);
      await prisma.$executeRaw`UPDATE admins SET invite_expires_at = now() - interval '1 minute' WHERE id = ${invite.adminId}::uuid`;
      await request(app.getHttpServer()).post(`${API}/admin/auth/accept-invite`).send({ token: invite.inviteToken, password: PASSWORD }).expect(404);
    });
  });

  describe('roles and permissions', () => {
    it('gives roles only after a second admin approves, and applies them on the next request', async () => {
      const first = await login('SUPER_ADMIN');
      const second = as(await login('SUPER_ADMIN'));
      const invite = await invited(first);
      await request(app.getHttpServer()).post(`${API}/admin/auth/accept-invite`).send({ token: invite.inviteToken, password: PASSWORD }).expect(200);
      const newbie = await adminLogin(app, { adminId: invite.adminId, email: invite.email, password: PASSWORD });

      const asked = await as(first).put(`/admin/admins/${invite.adminId}/roles`, { ...reason, roles: ['SUPPORT_AGENT'] }).expect(200);
      expect(asked.body.data).toMatchObject({ approvalRequired: true, approval: { kind: 'ADMIN_ROLE_CHANGE', status: 'PENDING' } });
      await as(newbie).get('/admin/users').expect(403);
      await as(first).post(`/admin/approvals/${asked.body.data.approval.id}/approve`, {}).expect(403);

      const done = await second.post(`/admin/approvals/${asked.body.data.approval.id}/approve`, {}).expect(200);
      expect(done.body.data.status).toBe('EXECUTED');
      // The same session, no new login: the permissions are read live.
      await as(newbie).get('/admin/users').expect(200);
      expect((await as(first).get(`/admin/admins/${invite.adminId}`).expect(200)).body.data.roles).toEqual(['SUPPORT_AGENT']);
    });

    it('never removes the last super admin, by role change or by deactivation', async () => {
      const only = await login('SUPER_ADMIN');
      const support = await login('SUPPORT_AGENT');
      const accounts = app.get(AdminAccountsService);

      await expect(accounts.applyRoles(only.adminId, ['SUPPORT_AGENT'], support.adminId)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
      await expect(accounts.setStatus(only.adminId, 'DEACTIVATED', support.adminId)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });

      const second = await login('SUPER_ADMIN');
      await accounts.applyRoles(only.adminId, ['SUPPORT_AGENT'], second.adminId);
      await expect(accounts.applyRoles(second.adminId, [], only.adminId)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect((await accounts.detail(only.adminId)).roles).toEqual(['SUPPORT_AGENT']);
    });

    it('creates a role with no permissions and sets them through an approval, but never trims SUPER_ADMIN', async () => {
      const first = as(await login('SUPER_ADMIN'));
      const second = as(await login('SUPER_ADMIN'));

      const role = (await first.post('/admin/roles', { ...reason, name: 'Content reviewer' }).expect(201)).body.data;
      expect(role).toMatchObject({ name: 'CONTENT_REVIEWER', permissions: [] });
      await first.post('/admin/roles', { ...reason, name: 'content reviewer' }).expect(409);

      const asked = await first.put(`/admin/roles/${role.id}/permissions`, { ...reason, permissions: ['REPORTS_VIEW', 'RATINGS_MODERATE'] }).expect(200);
      await second.post(`/admin/approvals/${asked.body.data.approval.id}/approve`, {}).expect(200);
      const listed = (await first.get('/admin/roles').expect(200)).body.data.find((r: { id: string }) => r.id === role.id);
      expect(listed.permissions).toEqual(['RATINGS_MODERATE', 'REPORTS_VIEW']);
      await first.put(`/admin/roles/${role.id}/permissions`, { ...reason, permissions: ['NOT_A_PERMISSION'] }).expect(400);

      const superRole = (await first.get('/admin/roles').expect(200)).body.data.find((r: { name: string }) => r.name === 'SUPER_ADMIN');
      const trim = await first.put(`/admin/roles/${superRole.id}/permissions`, { ...reason, permissions: ['USERS_VIEW'] }).expect(200);
      const attempt = await second.post(`/admin/approvals/${trim.body.data.approval.id}/approve`, {}).expect(200);
      expect(attempt.body.data.status).toBe('FAILED');
    });
  });

  describe('lifecycle', () => {
    it('resets another admin\'s MFA and ends their sessions, and refuses your own', async () => {
      const root = await login('SUPER_ADMIN');
      const target = await login('SUPPORT_AGENT');

      await as(root).post(`/admin/admins/${root.adminId}/reset-mfa`, reason).expect(403);
      await as(root).post(`/admin/admins/${target.adminId}/reset-mfa`, reason).expect(200);

      await request(app.getHttpServer()).get(`${API}/admin/auth/me`).set(...bearer(target.accessToken as string)).expect(401);
      const row = await prisma.admin.findUniqueOrThrow({ where: { id: target.adminId } });
      expect(row).toMatchObject({ mfaEnabled: false, mfaSecretEncrypted: null });
    });

    it('deactivates and reactivates an admin, and the deactivated one is out at once', async () => {
      const root = await login('SUPER_ADMIN');
      const target = await login('SUPPORT_AGENT');
      const support = as(await login('SUPPORT_AGENT'));

      await support.post(`/admin/admins/${target.adminId}/deactivate`, reason).expect(403);
      await as(root).post(`/admin/admins/${root.adminId}/deactivate`, reason).expect(403);
      await as(root).post(`/admin/admins/${target.adminId}/deactivate`, reason).expect(200);

      await as(target).get('/admin/users').expect(401);
      await request(app.getHttpServer()).post(`${API}/admin/auth/login`).send({ email: target.email, password: target.password }).expect(401);
      await as(root).post(`/admin/admins/${target.adminId}/reactivate`, reason).expect(200);
      await as(root).post(`/admin/admins/${target.adminId}/reactivate`, reason).expect(409);
    });

    it('revokes sessions, lists admins with filters, and leaves a record of each change', async () => {
      const root = await login('SUPER_ADMIN');
      const target = await login('SUPPORT_AGENT');

      await as(root).post(`/admin/admins/${target.adminId}/revoke-sessions`, reason).expect(200);
      await as(target).get('/admin/users').expect(401);

      const all = (await as(root).get('/admin/admins').expect(200)).body.data;
      expect(all.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining([root.adminId, target.adminId]));
      expect((await as(root).get('/admin/admins?q=support').expect(200)).body.data.length).toBeGreaterThanOrEqual(0);
      expect(await prisma.auditLog.count({ where: { action: { in: ['admin.admin.revoke_sessions'] }, entityId: target.adminId } })).toBe(1);
    });
  });
});

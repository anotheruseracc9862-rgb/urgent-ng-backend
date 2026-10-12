/**
 * P11-01: the admin framework. A four-eyes action cannot complete without a different admin who
 * holds the approving permission; every admin write needs a reason and is audited.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../../test/database.helper.js';
import { API, adminLogin, bearer, createAdmin, seedAdminRoles, seedPolicies, type TestAdmin } from '../../test/auth.helper.js';
import { ADMIN_PERMISSIONS, DEFAULT_ADMIN_ROLES } from '../admin.permissions.js';
import type { AuthenticatedAdmin } from '../decorators/admin-auth.decorator.js';
import { ApprovalExecutorRegistry, ApprovalService } from './approval.service.js';
import { AdminActionService } from './admin-action.service.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Admin framework (P11-01)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let ran: Array<Record<string, unknown>>;
  let failNext = false;

  beforeAll(async () => {
    app = await createTestApp();
    const registry = app.get(ApprovalExecutorRegistry);
    registry.register({
      kind: 'CONFIG_CHANGE',
      execute: async (payload) => {
        if (failNext) {
          failNext = false;
          throw new Error('boom');
        }
        ran.push(payload);
        return { applied: true };
      },
    });
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    await seedAdminRoles();
    ran = [];
    failNext = false;
  });
  afterAll(async () => {
    await app.close();
  });

  const asAdmin = (admin: TestAdmin, permissions: readonly string[] = ADMIN_PERMISSIONS): AuthenticatedAdmin => ({
    adminId: admin.adminId,
    sessionId: 'test',
    email: admin.email,
    displayName: 'Test Admin',
    roles: [],
    permissions: permissions as AuthenticatedAdmin['permissions'],
  });
  const get = (admin: TestAdmin, path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(admin.accessToken as string));
  const post = (admin: TestAdmin, path: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(`${API}${path}`).set(...bearer(admin.accessToken as string)).send(body);

  async function twoAdmins() {
    const a = await adminLogin(app, await createAdmin(app, { roles: ['SUPER_ADMIN'] }));
    const b = await adminLogin(app, await createAdmin(app, { roles: ['SUPER_ADMIN'] }));
    return { a, b };
  }

  const ask = (admin: TestAdmin, payload: Record<string, unknown> = { key: 'FREE_RUNNER_DAILY_OFFER_LIMIT', value: 12 }) =>
    app.get(ApprovalService).request(asAdmin(admin), {
      kind: 'CONFIG_CHANGE',
      reason: { code: 'ROUTINE_OPERATION' },
      summary: 'Set FREE_RUNNER_DAILY_OFFER_LIMIT to 12',
      targetType: 'config_value',
      targetId: 'FREE_RUNNER_DAILY_OFFER_LIMIT',
      payload,
    });

  describe('four eyes', () => {
    it('runs the action only when a different admin approves, and records both', async () => {
      const { a, b } = await twoAdmins();
      const asked = await ask(a);

      expect(asked).toMatchObject({ status: 'PENDING', requestedBy: a.adminId, canDecide: false });
      expect(ran).toHaveLength(0);

      const seenByB = await get(b, `/admin/approvals/${asked.id}`).expect(200);
      expect(seenByB.body.data.canDecide).toBe(true);
      const approved = await post(b, `/admin/approvals/${asked.id}/approve`, { note: 'Looks right' }).expect(200);

      expect(approved.body.data).toMatchObject({ status: 'EXECUTED', decidedBy: b.adminId, decisionNote: 'Looks right', result: { applied: true } });
      expect(ran).toEqual([{ key: 'FREE_RUNNER_DAILY_OFFER_LIMIT', value: 12 }]);
      const actions = (await prisma.auditLog.findMany({ where: { entityId: asked.id } })).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['admin.approval.requested', 'admin.approval.executed']));
    });

    it('refuses the admin who asked, in the API and in the database', async () => {
      const { a } = await twoAdmins();
      const asked = await ask(a);

      const res = await post(a, `/admin/approvals/${asked.id}/approve`).expect(403);

      expect(res.body.error.details.reason).toBe('SAME_ADMIN');
      expect(ran).toHaveLength(0);
      await expect(
        prisma.$executeRaw`UPDATE approval_requests SET status = 'APPROVED'::"ApprovalRequestStatus", decided_by = requested_by, decided_at = now() WHERE id = ${asked.id}::uuid`,
      ).rejects.toThrow();
    });

    it('refuses an admin without the approving permission, who also cannot see the request', async () => {
      const { a } = await twoAdmins();
      const support = await adminLogin(app, await createAdmin(app, { roles: ['SUPPORT_AGENT'] }));
      const asked = await ask(a);

      await post(support, `/admin/approvals/${asked.id}/approve`).expect(403);
      await get(support, `/admin/approvals/${asked.id}`).expect(404);
      expect((await get(support, '/admin/approvals').expect(200)).body.data).toHaveLength(0);
    });

    it('only one of two concurrent approvers runs the action', async () => {
      const { a, b } = await twoAdmins();
      const c = await adminLogin(app, await createAdmin(app, { roles: ['SUPER_ADMIN'] }));
      const asked = await ask(a);

      const results = await Promise.all([
        post(b, `/admin/approvals/${asked.id}/approve`),
        post(c, `/admin/approvals/${asked.id}/approve`),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(ran).toHaveLength(1);
    });

    it('does not run a rejected request, and a decided one cannot be decided again', async () => {
      const { a, b } = await twoAdmins();
      const asked = await ask(a);

      const rejected = await post(b, `/admin/approvals/${asked.id}/reject`, { note: 'No' }).expect(200);
      expect(rejected.body.data).toMatchObject({ status: 'REJECTED', decidedBy: b.adminId });
      await post(b, `/admin/approvals/${asked.id}/approve`).expect(409);
      expect(ran).toHaveLength(0);
    });

    it('records a failing action as FAILED with the reason, and does not hide it', async () => {
      const { a, b } = await twoAdmins();
      const asked = await ask(a);
      failNext = true;

      const res = await post(b, `/admin/approvals/${asked.id}/approve`).expect(200);

      expect(res.body.data.status).toBe('FAILED');
      expect(res.body.data.failureReason).toBeTruthy();
      expect(ran).toHaveLength(0);
    });

    it('expires a request nobody decided, and refuses to run it', async () => {
      const { a, b } = await twoAdmins();
      const asked = await ask(a);
      await prisma.$executeRaw`UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = ${asked.id}::uuid`;

      await post(b, `/admin/approvals/${asked.id}/approve`).expect(409);

      expect((await get(b, `/admin/approvals/${asked.id}`).expect(200)).body.data.status).toBe('EXPIRED');
      expect(ran).toHaveLength(0);
    });

    it('lets the requester withdraw it, and nobody else', async () => {
      const { a, b } = await twoAdmins();
      const asked = await ask(a);

      await post(b, `/admin/approvals/${asked.id}/cancel`).expect(403);
      const cancelled = await post(a, `/admin/approvals/${asked.id}/cancel`).expect(200);

      expect(cancelled.body.data.status).toBe('CANCELLED');
      await post(b, `/admin/approvals/${asked.id}/approve`).expect(409);
    });

    it('needs the kind\'s own permission to ask', async () => {
      const support = await adminLogin(app, await createAdmin(app, { roles: ['SUPPORT_AGENT'] }));

      await expect(
        app.get(ApprovalService).request(asAdmin(support, DEFAULT_ADMIN_ROLES.SUPPORT_AGENT.permissions), {
          kind: 'CONFIG_CHANGE',
          reason: { code: 'ROUTINE_OPERATION' },
          summary: 'x',
          payload: {},
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('filters the list by status and by "mine", and an anonymous caller is refused', async () => {
      const { a, b } = await twoAdmins();
      await ask(a);
      const second = await ask(a);
      await post(b, `/admin/approvals/${second.id}/reject`).expect(200);

      expect((await get(a, '/admin/approvals?status=PENDING').expect(200)).body.data).toHaveLength(1);
      expect((await get(a, '/admin/approvals?mine=true').expect(200)).body.data).toHaveLength(2);
      expect((await get(b, '/admin/approvals?mine=true').expect(200)).body.data).toHaveLength(0);
      await request(app.getHttpServer()).get(`${API}/admin/approvals`).expect(401);
    });
  });

  describe('reason and audit', () => {
    it('lists the reason codes', async () => {
      const { a } = await twoAdmins();

      const res = await get(a, '/admin/reason-codes').expect(200);

      expect(res.body.data.codes).toEqual(expect.arrayContaining(['POLICY_VIOLATION', 'OTHER']));
    });

    it('requires free text for OTHER and audits a success with the admin, reason and changed fields', async () => {
      const { a } = await twoAdmins();
      const actions = app.get(AdminActionService);
      const admin = asAdmin(a);

      await expect(
        actions.run({ admin, action: 'test.change', entityType: 'thing', reason: { code: 'OTHER' }, execute: async () => 1 }),
      ).rejects.toBeInstanceOf(DomainException);

      const entityId = '0198f0f0-0000-7000-8000-000000000001';
      const out = await actions.run({
        admin,
        action: 'test.change',
        entityType: 'thing',
        entityId,
        reason: { code: 'DATA_ERROR', text: 'typo' },
        before: async () => ({ name: 'a', count: 1 }),
        after: async () => ({ name: 'b', count: 1 }),
        execute: async () => 'done',
      });

      expect(out).toBe('done');
      const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'admin.test.change', entityId } });
      expect(row).toMatchObject({ actorType: 'ADMIN', actorId: a.adminId, reasonCode: 'DATA_ERROR' });
      expect(row.beforeHash).not.toBe(row.afterHash);
      expect(row.metadata).toMatchObject({ changed: ['name'], reasonText: 'typo' });
    });

    it('audits a failed attempt and rethrows the same error', async () => {
      const { a } = await twoAdmins();
      const admin = asAdmin(a);
      const entityId = '0198f0f0-0000-7000-8000-000000000002';

      await expect(
        app.get(AdminActionService).run({
          admin,
          action: 'test.fail',
          entityType: 'thing',
          entityId,
          reason: { code: 'ROUTINE_OPERATION' },
          execute: async () => {
            throw DomainException.of('RESOURCE_NOT_FOUND');
          },
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

      const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'admin.test.fail.failed', entityId } });
      expect(row.metadata).toMatchObject({ error: 'RESOURCE_NOT_FOUND' });
    });
  });
});

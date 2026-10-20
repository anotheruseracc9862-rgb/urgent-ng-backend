import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, fakeOtp, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { AccountService, type DeletionBlocker } from './account.service.js';
import { AuthAuditService } from './auth-audit.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('My account, blocking, devices and consent (HTTP)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  const server = () => app.getHttpServer();
  const get = (path: string, token: string) => request(server()).get(`${API}${path}`).set(...bearer(token));
  const post = (path: string, token: string) => request(server()).post(`${API}${path}`).set(...bearer(token));
  const put = (path: string, token: string) => request(server()).put(`${API}${path}`).set(...bearer(token));
  const patch = (path: string, token: string) => request(server()).patch(`${API}${path}`).set(...bearer(token));
  const del = (path: string, token: string) => request(server()).delete(`${API}${path}`).set(...bearer(token));

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    fakeOtp(app).reset();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('profile', () => {
    it('shows my own profile', async () => {
      const user = await signedInUser(app, { name: 'Ada Obi' });

      const res = await get('/me', user.accessToken).expect(200);

      expect(res.body.data).toMatchObject({
        id: user.userId,
        name: 'Ada Obi',
        firstName: 'Ada',
        lastName: 'Obi',
        phone: user.phone,
        phoneVerified: true,
        emailVerified: false,
        hasPassword: true,
        googleLinked: false,
        status: 'ACTIVE',
        startMode: null,
      });
    });

    it('updates the name (first and last name follow) and the start mode', async () => {
      const user = await signedInUser(app);

      const res = await patch('/me', user.accessToken).send({ name: 'Chidi Okeke Jr', startMode: 'RUNNER' }).expect(200);

      expect(res.body.data).toMatchObject({ name: 'Chidi Okeke Jr', firstName: 'Chidi', lastName: 'Okeke Jr', startMode: 'RUNNER' });
    });

    it('cannot change protected fields through PATCH /me', async () => {
      const user = await signedInUser(app);

      await patch('/me', user.accessToken).send({ status: 'SUSPENDED' }).expect(400);
      await patch('/me', user.accessToken).send({ passwordHash: 'x' }).expect(400);
      await patch('/me', user.accessToken).send({ startMode: 'ADMIN' }).expect(400);
    });

    it('shows other users a small public profile only', async () => {
      const a = await signedInUser(app, { name: 'Ada Obi' });
      const b = await signedInUser(app, { name: 'Chidi Okeke' });

      const res = await get(`/users/${b.userId}`, a.accessToken).expect(200);

      expect(Object.keys(res.body.data).sort()).toEqual(['badges', 'bio', 'firstName', 'id', 'lastInitial', 'memberSince', 'photoMediaId', 'stats']);
      expect(res.body.data).toMatchObject({
        firstName: 'Chidi',
        lastInitial: 'O',
        badges: [],
        stats: { completedAsRunner: 0, completedAsRequester: 0, runnerRating: { count: 0, average: null }, requesterRating: { count: 0, average: null } },
      });
      await get('/users/00000000-0000-4000-8000-000000000000', a.accessToken).expect(404);
    });
  });

  describe('account lifecycle', () => {
    it('deactivates and reactivates', async () => {
      const user = await signedInUser(app);

      const off = await post('/me/deactivate', user.accessToken).send({ reason: 'taking a break' }).expect(200);
      expect(off.body.data.status).toBe('DEACTIVATED');
      expect((await get('/me', user.accessToken).expect(200)).body.data.status).toBe('DEACTIVATED');

      const on = await post('/me/reactivate', user.accessToken).expect(200);
      expect(on.body.data.status).toBe('ACTIVE');
    });

    it('a deactivated user is blocked from marketplace-style actions but can read and come back', async () => {
      const user = await signedInUser(app);
      await post('/me/deactivate', user.accessToken).send({}).expect(200);

      const blocked = await post('/me/deactivate', user.accessToken).send({}).expect(403);

      expect(blocked.body.error.code).toBe('ACCOUNT_DEACTIVATED');
      await get('/me/sessions', user.accessToken).expect(200);
      await post('/me/reactivate', user.accessToken).expect(200);
    });

    it('refuses invalid transitions with a conflict', async () => {
      const user = await signedInUser(app);

      const res = await post('/me/reactivate', user.accessToken).expect(409);

      expect(res.body.error.code).toBe('RESOURCE_CONFLICT');
    });

    it('only one of several parallel deactivations wins', async () => {
      const user = await signedInUser(app);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => post('/me/deactivate', user.accessToken).send({})),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    });

    it('a deletion request starts a 14 day grace period', async () => {
      const user = await signedInUser(app);

      const res = await post('/me/delete-request', user.accessToken).send({ reason: 'leaving' }).expect(200);

      expect(res.body.data.status).toBe('DELETION_PENDING');
      const days = (new Date(res.body.data.deletionScheduledAt).getTime() - Date.now()) / 86400000;
      expect(days).toBeGreaterThan(13.99);
      expect(days).toBeLessThan(14.01);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(row.status).toBe('DELETION_PENDING');
      expect(row.deletionRequestedAt).not.toBeNull();
    });

    it('the grace period length comes from config', async () => {
      await app.get(BusinessConfigService).set('ACCOUNT_DELETION_GRACE_DAYS', 3);
      const user = await signedInUser(app);

      const res = await post('/me/delete-request', user.accessToken).send({}).expect(200);

      const days = (new Date(res.body.data.deletionScheduledAt).getTime() - Date.now()) / 86400000;
      expect(Math.round(days)).toBe(3);
    });

    it('cancelling deletion brings the account back, and only a pending one can be cancelled', async () => {
      const user = await signedInUser(app);
      await del('/me/delete-request', user.accessToken).expect(409);
      await post('/me/delete-request', user.accessToken).send({}).expect(200);

      const res = await del('/me/delete-request', user.accessToken).expect(200);

      expect(res.body.data.status).toBe('ACTIVE');
      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(row.deletionScheduledAt).toBeNull();
    });

    it('cancelling returns a deactivated account to DEACTIVATED, not ACTIVE', async () => {
      const user = await signedInUser(app);
      await post('/me/deactivate', user.accessToken).send({}).expect(200);
      await post('/me/delete-request', user.accessToken).send({}).expect(200);

      const res = await del('/me/delete-request', user.accessToken).expect(200);

      expect(res.body.data.status).toBe('DEACTIVATED');
    });

    it('a deletion-pending user can log in to cancel but not act like an active user', async () => {
      const user = await signedInUser(app);
      await post('/me/delete-request', user.accessToken).send({}).expect(200);

      const blocked = await post('/me/deactivate', user.accessToken).send({}).expect(403);

      expect(blocked.body.error.code).toBe('ACCOUNT_DELETION_PENDING');
      await del('/me/delete-request', user.accessToken).expect(200);
    });

    it('is refused with the reasons while something still depends on the account', async () => {
      const user = await signedInUser(app);
      const blocker: DeletionBlocker = {
        check: async () => [{ code: 'ACTIVE_ASSIGNMENT', message: 'You have an assignment in progress.' }],
      };
      const service = new AccountService(prisma as never, app.get(BusinessConfigService), app.get(AuthAuditService), [blocker]);

      await expect(service.requestDeletion(user.userId, undefined, {})).rejects.toMatchObject({
        code: 'DELETION_BLOCKED',
        details: { blockers: [{ code: 'ACTIVE_ASSIGNMENT', message: 'You have an assignment in progress.' }] },
      });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).status).toBe('ACTIVE');
    });

    it('audits every lifecycle change', async () => {
      const user = await signedInUser(app);
      await post('/me/deactivate', user.accessToken).send({ reason: 'x' }).expect(200);
      await post('/me/reactivate', user.accessToken).expect(200);
      await post('/me/delete-request', user.accessToken).send({}).expect(200);
      await del('/me/delete-request', user.accessToken).expect(200);

      const actions = (await prisma.auditLog.findMany({ where: { action: { startsWith: 'account.' } } })).map((l) => l.action);

      expect(actions.sort()).toEqual([
        'account.deactivated',
        'account.deletion_cancelled',
        'account.deletion_requested',
        'account.reactivated',
      ]);
    });
  });

  describe('notification preferences', () => {
    it('returns the full matrix with marketing off by default', async () => {
      const user = await signedInUser(app);

      const res = await get('/me/notification-preferences', user.accessToken).expect(200);

      expect(res.body.data).toHaveLength(15);
      const marketing = res.body.data.filter((p: { category: string }) => p.category === 'MARKETING');
      expect(marketing.every((p: { enabled: boolean }) => p.enabled === false)).toBe(true);
      const messaging = res.body.data.filter((p: { category: string }) => p.category === 'MESSAGING');
      expect(messaging.every((p: { enabled: boolean }) => p.enabled === true)).toBe(true);
      // Push is on by default for new messages and for errands near the person.
      for (const category of ['MESSAGING', 'MARKETPLACE']) {
        expect(res.body.data.find((p: { category: string; channel: string }) => p.category === category && p.channel === 'PUSH').enabled).toBe(true);
      }
    });

    it('saves changes and keeps them', async () => {
      const user = await signedInUser(app);

      await put('/me/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'MARKETPLACE', channel: 'PUSH', enabled: false }, { category: 'MARKETING', channel: 'EMAIL', enabled: true }] })
        .expect(200);
      await put('/me/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'MARKETPLACE', channel: 'PUSH', enabled: false }] })
        .expect(200);

      const res = await get('/me/notification-preferences', user.accessToken).expect(200);
      const find = (category: string, channel: string) =>
        res.body.data.find((p: { category: string; channel: string }) => p.category === category && p.channel === channel).enabled;
      expect(find('MARKETPLACE', 'PUSH')).toBe(false);
      expect(find('MARKETPLACE', 'EMAIL')).toBe(true);
      expect(find('MARKETING', 'EMAIL')).toBe(true);
      expect(await prisma.notificationPreference.count({ where: { userId: user.userId } })).toBe(2);
    });

    it('keeps transactional and safety notices on even if an old row says off, so the whole matrix can be saved back', async () => {
      const user = await signedInUser(app);
      await prisma.notificationPreference.createMany({
        data: [
          { userId: user.userId, category: 'SAFETY', channel: 'PUSH', enabled: false },
          { userId: user.userId, category: 'TRANSACTIONAL', channel: 'EMAIL', enabled: false },
        ],
      });

      const before = await get('/me/notification-preferences', user.accessToken).expect(200);
      const find = (rows: Array<{ category: string; channel: string; enabled: boolean }>, category: string, channel: string) =>
        rows.find((p) => p.category === category && p.channel === channel)!.enabled;
      expect(find(before.body.data, 'SAFETY', 'PUSH')).toBe(true);
      expect(find(before.body.data, 'TRANSACTIONAL', 'EMAIL')).toBe(true);

      // The settings page echoes what it was given. That must be accepted.
      await put('/me/notification-preferences', user.accessToken).send({ preferences: before.body.data }).expect(200);
    });

    it('does not let transactional or safety notices be switched off', async () => {
      const user = await signedInUser(app);

      const res = await put('/me/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'SAFETY', channel: 'PUSH', enabled: false }] })
        .expect(400);

      expect(res.body.error.details.categories).toEqual(['SAFETY']);
    });

    it('rejects unknown categories and channels', async () => {
      const user = await signedInUser(app);

      await put('/me/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'GOSSIP', channel: 'PUSH', enabled: true }] })
        .expect(400);
      await put('/me/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'MESSAGING', channel: 'SMS', enabled: true }] })
        .expect(400);
    });
  });

  describe('consent', () => {
    it('lists the history and what is still outstanding', async () => {
      const user = await signedInUser(app);

      const res = await get('/me/consents', user.accessToken).expect(200);

      expect(res.body.data.consents).toHaveLength(5);
      expect(res.body.data.outstanding).toEqual([]);
    });

    it('accepts a published version once (repeat returns the same record)', async () => {
      const user = await signedInUser(app);

      const first = await post('/me/consents', user.accessToken).send({ type: 'LOCATION_SHARING', version: '1.0' }).expect(200);
      const again = await post('/me/consents', user.accessToken).send({ type: 'LOCATION_SHARING', version: '1.0' }).expect(200);

      expect(again.body.data.id).toBe(first.body.data.id);
      expect(await prisma.consentRecord.count({ where: { userId: user.userId, consentType: 'LOCATION_SHARING' } })).toBe(1);
    });

    it('rejects a version that does not exist', async () => {
      const user = await signedInUser(app);

      await post('/me/consents', user.accessToken).send({ type: 'TERMS_OF_SERVICE', version: '7.7' }).expect(400);
    });

    it('records IP and user agent with the acceptance', async () => {
      const user = await signedInUser(app);
      await post('/me/consents', user.accessToken).set('User-Agent', 'UrgentTest/1.0').send({ type: 'LOCATION_SHARING', version: '1.0' }).expect(200);

      const [row] = await prisma.$queryRaw<Array<{ user_agent: string; ip: string | null }>>`
        SELECT user_agent, host(ip_address) AS ip FROM consent_records WHERE consent_type = 'LOCATION_SHARING'::"ConsentType"
      `;

      expect(row.user_agent).toBe('UrgentTest/1.0');
      expect(row.ip).not.toBeNull();
    });

    it('marketing consent is separate and can be withdrawn; required ones cannot', async () => {
      const user = await signedInUser(app);
      const marketing = await post('/me/consents', user.accessToken).send({ type: 'MARKETING_COMMUNICATIONS', version: '1.0' }).expect(200);
      const history = await get('/me/consents', user.accessToken);
      const terms = history.body.data.consents.find((c: { type: string }) => c.type === 'TERMS_OF_SERVICE');

      await post(`/me/consents/${marketing.body.data.id}/withdraw`, user.accessToken).expect(204);
      await post(`/me/consents/${terms.id}/withdraw`, user.accessToken).expect(400);

      const after = await get('/me/consents', user.accessToken);
      const m = after.body.data.consents.find((c: { type: string }) => c.type === 'MARKETING_COMMUNICATIONS');
      expect(m.withdrawnAt).not.toBeNull();
    });

    it('cannot withdraw another user’s consent', async () => {
      const a = await signedInUser(app);
      const b = await signedInUser(app);
      const aConsent = (await get('/me/consents', a.accessToken)).body.data.consents[0];

      await post(`/me/consents/${aConsent.id}/withdraw`, b.accessToken).expect(404);
    });

    it('consent records cannot be deleted', async () => {
      await signedInUser(app);

      await expect(prisma.$executeRaw`DELETE FROM consent_records`).rejects.toThrow(/not allowed/);
    });
  });

  describe('blocking', () => {
    it('blocks and unblocks, idempotently', async () => {
      const a = await signedInUser(app);
      const b = await signedInUser(app);

      await post(`/users/${b.userId}/block`, a.accessToken).expect(204);
      await post(`/users/${b.userId}/block`, a.accessToken).expect(204);
      expect(await prisma.block.count()).toBe(1);

      const list = await get('/me/blocks', a.accessToken).expect(200);
      expect(list.body.data).toEqual([expect.objectContaining({ userId: b.userId, firstName: 'Ada' })]);

      await del(`/users/${b.userId}/block`, a.accessToken).expect(204);
      await del(`/users/${b.userId}/block`, a.accessToken).expect(204);
      expect((await get('/me/blocks', a.accessToken)).body.data).toEqual([]);
    });

    it('can block again after unblocking (the old row is soft-deleted)', async () => {
      const a = await signedInUser(app);
      const b = await signedInUser(app);
      await post(`/users/${b.userId}/block`, a.accessToken).expect(204);
      await del(`/users/${b.userId}/block`, a.accessToken).expect(204);

      await post(`/users/${b.userId}/block`, a.accessToken).expect(204);

      expect((await get('/me/blocks', a.accessToken)).body.data).toHaveLength(1);
      expect(await prisma.block.count()).toBe(2); // history kept
      expect(await prisma.block.count({ where: { deletedAt: null } })).toBe(1);
    });

    it('rejects blocking yourself, an unknown user, or a non-UUID', async () => {
      const a = await signedInUser(app);

      await post(`/users/${a.userId}/block`, a.accessToken).expect(400);
      await post('/users/00000000-0000-4000-8000-000000000000/block', a.accessToken).expect(404);
      await post('/users/abc/block', a.accessToken).expect(400);
    });

    it('a block is private: the other user does not see it in their list', async () => {
      const a = await signedInUser(app);
      const b = await signedInUser(app);
      await post(`/users/${b.userId}/block`, a.accessToken).expect(204);

      expect((await get('/me/blocks', b.accessToken)).body.data).toEqual([]);
    });
  });

  describe('devices', () => {
    const token = 'fcm-token-aaaaaaaaaaaaaaaa';

    it('registers, lists and removes a device', async () => {
      const user = await signedInUser(app);

      const created = await post('/me/devices', user.accessToken).send({ type: 'MOBILE_PUSH', pushToken: token }).expect(201);
      const list = await get('/me/devices', user.accessToken).expect(200);

      expect(list.body.data).toEqual([expect.objectContaining({ id: created.body.data.id, type: 'MOBILE_PUSH', active: true })]);
      expect(JSON.stringify(list.body)).not.toContain(token);
      await del(`/me/devices/${created.body.data.id}`, user.accessToken).expect(204);
      expect((await get('/me/devices', user.accessToken)).body.data).toEqual([]);
    });

    it('registering the same token again refreshes the one device', async () => {
      const user = await signedInUser(app);

      const first = await post('/me/devices', user.accessToken).send({ type: 'MOBILE_PUSH', pushToken: token }).expect(201);
      const second = await post('/me/devices', user.accessToken).send({ type: 'MOBILE_PUSH', pushToken: token }).expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await prisma.device.count()).toBe(1);
    });

    it('a token moves to the new account when another user registers it', async () => {
      const a = await signedInUser(app);
      const b = await signedInUser(app);
      await post('/me/devices', a.accessToken).send({ type: 'MOBILE_PUSH', pushToken: token }).expect(201);

      await post('/me/devices', b.accessToken).send({ type: 'MOBILE_PUSH', pushToken: token }).expect(201);

      expect((await get('/me/devices', a.accessToken)).body.data).toEqual([]);
      expect((await get('/me/devices', b.accessToken)).body.data).toHaveLength(1);
    });

    it('a token can be registered again after its device was removed', async () => {
      const user = await signedInUser(app);
      const first = await post('/me/devices', user.accessToken).send({ type: 'WEB_PUSH', pushToken: token }).expect(201);
      await del(`/me/devices/${first.body.data.id}`, user.accessToken).expect(204);

      const again = await post('/me/devices', user.accessToken).send({ type: 'WEB_PUSH', pushToken: token }).expect(201);

      expect(again.body.data.id).not.toBe(first.body.data.id);
    });

    it('parallel registrations of one token create a single device', async () => {
      const user = await signedInUser(app);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => post('/me/devices', user.accessToken).send({ type: 'MOBILE_PUSH', pushToken: token })),
      );

      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(await prisma.device.count({ where: { deletedAt: null } })).toBe(1);
    });

    it('cannot remove another user’s device', async () => {
      const a = await signedInUser(app);
      const b = await signedInUser(app);
      const device = await post('/me/devices', a.accessToken).send({ type: 'MOBILE_PUSH', pushToken: token }).expect(201);

      await del(`/me/devices/${device.body.data.id}`, b.accessToken).expect(404);
      expect((await get('/me/devices', a.accessToken)).body.data).toHaveLength(1);
    });

    it('validates the device type and token', async () => {
      const user = await signedInUser(app);

      await post('/me/devices', user.accessToken).send({ type: 'PAGER', pushToken: token }).expect(400);
      await post('/me/devices', user.accessToken).send({ type: 'MOBILE_PUSH', pushToken: 'x' }).expect(400);
    });
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import {
  API,
  REQUIRED_CONSENTS,
  bearer,
  loginMobile,
  registerUser,
  seedPolicies,
  signedInUser,
  verifyUser,
} from '../test/auth.helper.js';
import { AccountService, type DeletionBlocker } from './account.service.js';
import { AccountDeletionSweeper } from '../scheduler/account-deletion.sweeper.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { AuthAuditService } from './auth-audit.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Account deletion lifecycle (sweeper)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  const accounts = () => app.get(AccountService);
  const expire = (userId: string) =>
    prisma.$executeRaw`UPDATE users SET deletion_scheduled_at = now() - interval '1 minute' WHERE id = ${userId}::uuid`;
  const post = (path: string, token: string) => request(app.getHttpServer()).post(`${API}${path}`).set(...bearer(token));
  const withBlocker = (blocker: DeletionBlocker) =>
    new AccountService(prisma as never, app.get(BusinessConfigService), app.get(AuthAuditService), [blocker]);
  const openCase: DeletionBlocker = { check: async () => [{ code: 'OPEN_DISPUTE', message: 'open' }] };

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
  });
  afterAll(async () => {
    await app.close();
  });

  it('turns an account into DELETED after the grace period and ends its sessions and devices', async () => {
    const user = await signedInUser(app);
    await post('/me/devices', user.accessToken).send({ type: 'MOBILE_PUSH', pushToken: 'fcm-token-aaaaaaaa' });
    await post('/me/delete-request', user.accessToken).send({}).expect(200);
    await expire(user.userId);

    expect(await accounts().finalizeDueDeletions()).toBe(1);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(row.status).toBe('DELETED');
    expect(row.deletedAt).not.toBeNull();
    expect(await prisma.authSession.count({ where: { userId: user.userId, revokedAt: null } })).toBe(0);
    expect(await prisma.device.count({ where: { userId: user.userId, deletedAt: null } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'account.deleted' } })).toBe(1);
    await request(app.getHttpServer()).get(`${API}/me`).set(...bearer(user.accessToken)).expect(401);
  });

  it('does not touch accounts still inside the grace period, or active ones', async () => {
    const pending = await signedInUser(app);
    const active = await signedInUser(app);
    await post('/me/delete-request', pending.accessToken).send({}).expect(200);

    expect(await accounts().finalizeDueDeletions()).toBe(0);

    expect((await prisma.user.findUniqueOrThrow({ where: { id: pending.userId } })).status).toBe('DELETION_PENDING');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: active.userId } })).status).toBe('ACTIVE');
  });

  it('a cancelled deletion is never finalised', async () => {
    const user = await signedInUser(app);
    await post('/me/delete-request', user.accessToken).send({}).expect(200);
    await request(app.getHttpServer()).delete(`${API}/me/delete-request`).set(...bearer(user.accessToken)).expect(200);

    expect(await accounts().finalizeDueDeletions()).toBe(0);
  });

  it('postpones a day when a blocker appeared during the grace period', async () => {
    const user = await signedInUser(app);
    await post('/me/delete-request', user.accessToken).send({}).expect(200);
    await expire(user.userId);

    expect(await withBlocker(openCase).finalizeDueDeletions()).toBe(0);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(row.status).toBe('DELETION_PENDING');
    const [{ hours }] = await prisma.$queryRaw<Array<{ hours: number }>>`
      SELECT (extract(epoch FROM (deletion_scheduled_at - now())) / 3600)::float AS hours FROM users WHERE id = ${user.userId}::uuid
    `;
    expect(hours).toBeGreaterThan(20);
  });

  it('is safe to run twice at once (each account deleted once)', async () => {
    const user = await signedInUser(app);
    await post('/me/delete-request', user.accessToken).send({}).expect(200);
    await expire(user.userId);

    const counts = await Promise.all([accounts().finalizeDueDeletions(), accounts().finalizeDueDeletions()]);

    expect(counts[0] + counts[1]).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'account.deleted' } })).toBe(1);
  });

  describe('anonymisation', () => {
    const deleteLongAgo = async (days: number) => {
      const user = await registerUser(app, { email: 'ada@example.com' });
      await verifyUser(app, user);
      await loginMobile(app, user);
      await prisma.$executeRaw`
        UPDATE users SET status = 'DELETED'::"UserStatus", deleted_at = now() - make_interval(days => ${days}::int)
        WHERE id = ${user.userId}::uuid
      `;
      return user;
    };

    it('scrubs personal data after ANONYMISATION_DAYS and keeps the row', async () => {
      const user = await deleteLongAgo(31);

      expect(await accounts().anonymiseDue()).toBe(1);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(row).toMatchObject({
        name: 'Deleted User',
        firstName: 'Deleted',
        lastName: 'User',
        email: null,
        phoneE164: null,
        emailVerifiedAt: null,
      });
      expect(row.anonymisedAt).not.toBeNull();
      expect(row.passwordHash.startsWith('anonymised:')).toBe(true);
      expect(await prisma.auditLog.count({ where: { action: 'account.anonymised' } })).toBe(1);
    });

    it('keeps consent evidence but clears its IP and user agent', async () => {
      const user = await deleteLongAgo(31);

      await accounts().anonymiseDue();

      const consents = await prisma.consentRecord.findMany({ where: { userId: user.userId } });
      expect(consents.length).toBeGreaterThan(0);
      expect(consents.every((c) => c.ipAddress === null && c.userAgent === null)).toBe(true);
    });

    it('waits until the configured number of days has passed', async () => {
      await deleteLongAgo(10);

      expect(await accounts().anonymiseDue()).toBe(0);

      await app.get(BusinessConfigService).set('ANONYMISATION_DAYS', 5);
      expect(await accounts().anonymiseDue()).toBe(1);
    });

    it('does not anonymise an account tied to an open case', async () => {
      const user = await deleteLongAgo(60);

      expect(await withBlocker(openCase).anonymiseDue()).toBe(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).email).toBe('ada@example.com');
    });

    it('runs only once per account', async () => {
      await deleteLongAgo(31);
      await accounts().anonymiseDue();

      expect(await accounts().anonymiseDue()).toBe(0);
    });

    it('frees the phone and email for a new registration', async () => {
      await deleteLongAgo(31);
      await accounts().anonymiseDue();

      await request(app.getHttpServer())
        .post(`${API}/auth/register`)
        .send({ name: 'New Owner', email: 'ada@example.com', password: 'Str0ng-passw0rd!', consents: REQUIRED_CONSENTS })
        .expect(201);
    });

    it('a live account must still have a phone or an email', async () => {
      const user = await registerUser(app);

      await expect(
        prisma.$executeRaw`UPDATE users SET phone_e164 = NULL WHERE id = ${user.userId}::uuid`,
      ).rejects.toThrow(/users_email_or_phone/);
    });
  });

  it('the sweeper class runs both steps', async () => {
    const user = await signedInUser(app);
    await post('/me/delete-request', user.accessToken).send({}).expect(200);
    await expire(user.userId);
    const sweeper = new AccountDeletionSweeper(prisma as never, accounts());

    expect(await sweeper['processBatch']()).toBe(1);
  });
});

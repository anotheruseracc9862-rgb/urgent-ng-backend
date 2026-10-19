/**
 * P8-03: the notification engine (Backend PRD 19). Events go through the real dispatcher; the
 * providers are the fakes. Real PostgreSQL and Redis.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { acceptAssignment, offerScene, selectRunner, selectedScene } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { EventDispatcher } from '../queue/event-dispatcher.js';
import { PUSH_PROVIDER } from '../common/providers/push.provider.js';
import { EMAIL_PROVIDER } from '../common/providers/email.provider.js';
import type { FakePushProvider } from '../common/providers/fakes/push.fake.js';
import type { FakeEmailProvider } from '../common/providers/fakes/email.fake.js';
import { DeviceService } from '../auth/device.service.js';
import { NotificationPreferenceService } from '../auth/notification-preference.service.js';
import { NotificationService } from './notification.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Notification engine (P8-03)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categoryId: string;
  const push = () => app.get<FakePushProvider>(PUSH_PROVIDER);
  const email = () => app.get<FakeEmailProvider>(EMAIL_PROVIDER);

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categoryId = (await seedCategories()).delivery;
    push().clearCalls();
    email().clearCalls();
  });
  afterAll(async () => {
    await app.close();
  });

  type Authed = { accessToken: string; userId: string };
  const list = async (user: Authed, query = '') =>
    (await request(app.getHttpServer()).get(`${API}/notifications${query}`).set(...bearer(user.accessToken)).expect(200)).body.data as Array<{
      id: string;
      type: string;
      category: string;
      title: string;
      body: string;
      readAt: string | null;
      data: Record<string, unknown>;
    }>;
  const ofType = async (user: Authed, type: string) => (await list(user)).filter((n) => n.type === type);
  const deliveries = (notificationId: string) =>
    prisma.notificationDelivery.findMany({ where: { notificationId }, orderBy: { channel: 'asc' } });
  const registerDevice = (user: Authed, token = `tok-${user.userId}`) => app.get(DeviceService).register(user.userId, 'MOBILE_PUSH', token);

  describe('events become notifications', () => {
    it('a new offer notifies the requester only, with the runner name and the amount', async () => {
      const s = await offerScene(app, categoryId);
      await dispatchOutbox(app, { eventType: 'offer.created' });

      const notices = await ofType(s.requester, 'offer.new');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ category: 'MARKETPLACE', title: 'New offer' });
      expect(notices[0].body).toContain('₦500');
      expect(notices[0].body).toContain('Collect a parcel');
      expect(notices[0].data).toMatchObject({ errandId: s.errandId, offerId: s.offerId });
      expect(await ofType(s.runner, 'offer.new')).toHaveLength(0);
    });

    it('the same event delivered twice produces one notification', async () => {
      const s = await offerScene(app, categoryId);
      const [event] = await dispatchOutbox(app, { eventType: 'offer.created' });

      await app.get(EventDispatcher).dispatch(event);
      await app.get(EventDispatcher).dispatch(event);

      expect(await ofType(s.requester, 'offer.new')).toHaveLength(1);
    });

    it('selection tells the runner (mandatory class, with the deadline), acceptance tells the requester', async () => {
      const s = await selectedScene(app, categoryId);
      await dispatchOutbox(app);

      const selected = await ofType(s.runner, 'assignment.selected');
      expect(selected).toHaveLength(1);
      expect(selected[0].category).toBe('TRANSACTIONAL');
      expect(selected[0].body).toMatch(/before \d{2}:\d{2}/);

      await acceptAssignment(app, s.runner, s.assignmentId).expect(201);
      await dispatchOutbox(app);
      const accepted = await ofType(s.requester, 'assignment.accepted');
      expect(accepted).toHaveLength(1);
      expect(accepted[0].data).toMatchObject({ assignmentId: s.assignmentId });
    });

    it('the runner who was not chosen is told, once', async () => {
      const first = await offerScene(app, categoryId);
      const { addOffer } = await import('../test/assignment.helper.js');
      const rival = await addOffer(app, first.errandId);
      await selectRunner(app, first.requester, first.errandId, first.offerId, first.offerVersion).expect(201);

      await dispatchOutbox(app);

      const notices = await ofType(rival.runner as Authed, 'offer.not_selected');
      expect(notices).toHaveLength(1);
      expect(await ofType(first.runner, 'offer.not_selected')).toHaveLength(0);
    });

    it('verification notices are mandatory and also go by email when the address is verified', async () => {
      const user = await signedInUser(app, { email: 'ada.runner@example.com' });
      await prisma.$executeRaw`UPDATE users SET email_verified_at = now() WHERE id = ${user.userId}::uuid`;
      const attemptId = '01a12638-0000-7000-8000-000000000001';
      await prisma.outboxEvent.create({
        data: { eventType: 'verification.completed', aggregateType: 'verification_attempt', payload: { userId: user.userId, attemptId, status: 'VERIFIED' } },
      });

      await dispatchOutbox(app, { eventType: 'verification.completed' });

      const notices = await ofType(user, 'verification.completed');
      expect(notices).toHaveLength(1);
      expect(notices[0].category).toBe('TRANSACTIONAL');
      expect(email().getCalls('send')).toHaveLength(1);
      const channels = (await deliveries(notices[0].id)).map((d) => [d.channel, d.status]);
      expect(channels).toEqual(expect.arrayContaining([['IN_APP', 'SENT'], ['EMAIL', 'SENT']]));
    });
  });

  describe('the email is the designed one', () => {
    const sentEmail = () => email().getCalls('send')[0].args[0] as { to: string; subject: string; html: string; text: string };

    it('a receipt goes out in the Urgent.ng layout, written from the values it was sent with, in HTML and plain text', async () => {
      const user = await signedInUser(app, { email: 'musa.runner@example.com' });
      await prisma.$executeRaw`UPDATE users SET email_verified_at = now() WHERE id = ${user.userId}::uuid`;

      await app.get(NotificationService).notify({
        userId: user.userId,
        template: 'billing.receipt',
        vars: { product: 'Runner Pro', amount: '₦3,000.00', vat: '₦209.30', reference: 'UG-20261018-4471' },
        data: { orderId: 'order-1' },
        dedupeKey: 'order:order-1:receipt',
      });

      const message = sentEmail();
      expect(message.to).toBe('musa.runner@example.com');
      expect(message.subject).toBe('Your Urgent.ng receipt: Runner Pro');
      expect(message.html).toContain('<!doctype html>');
      expect(message.html).toContain('Thanks, your payment went through');
      expect(message.html).toContain('UG-20261018-4471');
      expect(message.html).toContain('₦209.30');
      expect(message.html).toContain('/assets/email/logo.png');
      expect(message.html).toContain('/profile/orders');
      expect(message.text).toContain('Reference: UG-20261018-4471');
      expect(message.text).not.toContain('<');
    });

    it('greets the person by first name', async () => {
      const user = await signedInUser(app, { email: 'ada.email@example.com' });
      await prisma.$executeRaw`UPDATE users SET email_verified_at = now(), first_name = 'Ada' WHERE id = ${user.userId}::uuid`;

      await app.get(NotificationService).notify({
        userId: user.userId, template: 'account.password_changed', vars: {}, data: {}, dedupeKey: 'pw:1',
      });

      expect(sentEmail().html).toContain('Hi Ada, the password on your Urgent.ng account was changed.');
      expect(sentEmail().html).toContain('Secure my account');
    });

    it('the values kept for the email never reach the app, the live feed or the phone', async () => {
      const user = await signedInUser(app, { email: 'private.values@example.com' });
      await prisma.$executeRaw`UPDATE users SET email_verified_at = now() WHERE id = ${user.userId}::uuid`;
      await registerDevice(user);

      await app.get(NotificationService).notify({
        userId: user.userId,
        template: 'billing.receipt',
        vars: { product: 'Runner Pro', amount: '₦3,000.00', vat: '₦209.30', reference: 'UG-SECRET-1' },
        data: { orderId: 'order-2' },
        dedupeKey: 'order:order-2:receipt',
      });

      const [notice] = await ofType(user, 'billing.receipt');
      expect(notice.data).toEqual({ orderId: 'order-2', type: 'billing.receipt' });
      // (The reference is in the in-app text itself, so check the data the app is handed, not the whole row.)
      expect(JSON.stringify(notice.data)).not.toContain('UG-SECRET-1');
      const pushed = push().getCalls('send')[0]?.args[0] as { data: Record<string, string> } | undefined;
      expect(pushed).toBeDefined();
      expect(Object.keys(pushed!.data).sort()).toEqual(['orderId', 'type']);
      // It is stored, though, so a retry after a failed send can still write the email.
      const stored = await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } });
      expect((stored.data as Record<string, unknown>).emailVars).toMatchObject({ reference: 'UG-SECRET-1' });
    });

    it('a service notice written with markup is sent as text, not as markup', async () => {
      const user = await signedInUser(app, { email: 'notice.reader@example.com' });
      await prisma.$executeRaw`UPDATE users SET email_verified_at = now() WHERE id = ${user.userId}::uuid`;

      await app.get(NotificationService).notify({
        userId: user.userId, template: 'system.announcement', vars: { message: '<script>alert(1)</script> Maintenance on Sunday' }, data: {}, dedupeKey: 'ann:1',
      });

      expect(sentEmail().html).not.toContain('<script>alert(1)</script>');
      expect(sentEmail().html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Maintenance on Sunday');
    });
  });

  describe('preferences', () => {
    it('an optional category switched off creates nothing; mandatory notices still arrive', async () => {
      const s = await selectedScene(app, categoryId);
      await app.get(NotificationPreferenceService).set(s.requester.userId, [{ category: 'MARKETPLACE', channel: 'IN_APP', enabled: false }]);
      await app.get(NotificationPreferenceService).set(s.runner.userId, [{ category: 'MARKETPLACE', channel: 'IN_APP', enabled: false }]);

      await dispatchOutbox(app);

      expect(await ofType(s.requester, 'offer.new')).toHaveLength(0);
      expect(await ofType(s.runner, 'assignment.selected')).toHaveLength(1);
    });

    it('a channel switched off suppresses only that channel, with the reason', async () => {
      const s = await offerScene(app, categoryId);
      await registerDevice(s.requester);
      await app.get(NotificationPreferenceService).set(s.requester.userId, [{ category: 'MARKETPLACE', channel: 'PUSH', enabled: false }]);

      await dispatchOutbox(app, { eventType: 'offer.created' });

      const [notice] = await ofType(s.requester, 'offer.new');
      expect(notice).toBeTruthy();
      const pushDelivery = (await deliveries(notice.id)).find((d) => d.channel === 'PUSH');
      expect(pushDelivery).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'PREFERENCE' });
      expect(push().getCalls('send')).toHaveLength(0);
    });
  });

  describe('push', () => {
    it('is sent to the user\'s active devices with the deep-link data, and recorded', async () => {
      const s = await selectedScene(app, categoryId);
      await registerDevice(s.runner, 'runner-token');

      await dispatchOutbox(app, { eventType: 'assignment.selected' });

      const calls = push().getCalls('send');
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0]).toMatchObject({ token: 'runner-token', title: 'You were selected' });
      expect((calls[0].args[0] as { data: Record<string, string> }).data).toMatchObject({ assignmentId: s.assignmentId, type: 'assignment.selected' });
      const [notice] = await ofType(s.runner, 'assignment.selected');
      expect((await deliveries(notice.id)).find((d) => d.channel === 'PUSH')).toMatchObject({ status: 'SENT', attempts: 1 });
    });

    it('a failed push keeps the in-app notification and is retried, never duplicated', async () => {
      const s = await selectedScene(app, categoryId);
      await registerDevice(s.runner);
      push().scriptOutcomes('send', [{ success: false, error: 'provider timeout' }]);

      await expect(dispatchOutbox(app, { eventType: 'assignment.selected' })).rejects.toThrow();

      const [notice] = await ofType(s.runner, 'assignment.selected');
      expect(notice).toBeTruthy();
      expect((await deliveries(notice.id)).find((d) => d.channel === 'PUSH')).toMatchObject({ status: 'FAILED', attempts: 1, lastError: 'provider timeout' });

      // The queue retries the same event: one notification, the push goes out now.
      await dispatchOutbox(app, { eventType: 'assignment.selected' });
      expect(await ofType(s.runner, 'assignment.selected')).toHaveLength(1);
      expect((await deliveries(notice.id)).find((d) => d.channel === 'PUSH')).toMatchObject({ status: 'SENT', attempts: 2 });
    });

    it('an invalid token is deactivated and does not fail the event', async () => {
      const s = await selectedScene(app, categoryId);
      const device = await registerDevice(s.runner, 'dead-token');
      push().scriptOutcomes('send', [{ success: false, error: 'unregistered', invalidToken: true }]);

      await dispatchOutbox(app, { eventType: 'assignment.selected' });

      expect((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).active).toBe(false);
      const [notice] = await ofType(s.runner, 'assignment.selected');
      expect((await deliveries(notice.id)).find((d) => d.channel === 'PUSH')).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'NO_DEVICE' });
    });

    it('marketplace push is held during quiet hours, but mandatory notices ignore them', async () => {
      const s = await selectedScene(app, categoryId);
      await registerDevice(s.requester, 'requester-token');
      await registerDevice(s.runner, 'runner-token');
      // 23:30 in Lagos is 22:30 UTC.
      await prisma.$executeRaw`UPDATE outbox_events SET occurred_at = date_trunc('day', now()) + interval '22 hours 30 minutes'`;

      await dispatchOutbox(app, { eventType: ['offer.created', 'assignment.selected'] });

      const [offer] = await ofType(s.requester, 'offer.new');
      expect((await deliveries(offer.id)).find((d) => d.channel === 'PUSH')).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'QUIET_HOURS' });
      const [selected] = await ofType(s.runner, 'assignment.selected');
      expect((await deliveries(selected.id)).find((d) => d.channel === 'PUSH')).toMatchObject({ status: 'SENT' });
    });

    it('a user with no device simply has no push', async () => {
      const s = await offerScene(app, categoryId);
      // Midday in Lagos, so the answer does not depend on when the suite runs.
      await prisma.$executeRaw`UPDATE outbox_events SET occurred_at = date_trunc('day', now()) + interval '11 hours'`;
      await dispatchOutbox(app, { eventType: 'offer.created' });
      const [notice] = await ofType(s.requester, 'offer.new');
      expect((await deliveries(notice.id)).find((d) => d.channel === 'PUSH')).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'NO_DEVICE' });
    });
  });

  describe('templates', () => {
    it('an admin override replaces the copy; an inactive template sends nothing', async () => {
      const s = await offerScene(app, categoryId);
      await prisma.notificationTemplate.create({
        data: { key: 'offer.new', category: 'MARKETPLACE', titleTemplate: 'Fresh offer!', bodyTemplate: '{runnerName} wants {amount}.' },
      });
      await dispatchOutbox(app, { eventType: 'offer.created' });
      const [notice] = await ofType(s.requester, 'offer.new');
      expect(notice).toMatchObject({ title: 'Fresh offer!' });
      expect(notice.body).toMatch(/wants ₦500\./);

      const other = await selectedScene(app, categoryId);
      await prisma.notificationTemplate.update({ where: { key: 'offer.new' }, data: { active: false } });
      await dispatchOutbox(app, { eventType: 'offer.created' });
      expect(await ofType(other.requester, 'offer.new')).toHaveLength(0);
    });
  });

  describe('the list', () => {
    it('filters offer and progress topics before pagination, independently of category, unread and ownership', async () => {
      const user = await signedInUser(app);
      const stranger = await signedInUser(app);
      const entries = [
        ['offer.new', 'MARKETPLACE', false],
        ['account.password_changed', 'TRANSACTIONAL', false],
        ['assignment.accepted', 'TRANSACTIONAL', true],
        ['execution.receipt_added', 'MARKETPLACE', false],
        ['offer.countered', 'MARKETPLACE', true],
        ['message.new', 'MESSAGING', false],
        ['errand.completed.runner', 'TRANSACTIONAL', false],
        ['errand.nearby', 'MARKETPLACE', false],
        ['change_request.created', 'TRANSACTIONAL', false],
        ['payment_agreement.updated', 'MARKETPLACE', false],
        ['no_show.reported', 'TRANSACTIONAL', false],
        ['errand.expired', 'MARKETPLACE', false],
      ] as const;
      await prisma.notification.createMany({ data: entries.map(([type, category, read], index) => ({
        userId: user.userId, type, category, title: type, body: 'Notification filter test',
        createdAt: new Date(Date.now() - index * 1000), readAt: read ? new Date() : null,
      })) });
      await prisma.notification.create({ data: {
        userId: stranger.userId, type: 'offer.new', category: 'MARKETPLACE', title: 'Private offer', body: 'Another user',
      } });

      const pages = async (topic: string, limit: number) => {
        const types: string[] = [];
        let cursor: string | undefined;
        do {
          const response = await request(app.getHttpServer()).get(`${API}/notifications`)
            .query({ topic, limit, ...(cursor ? { cursor } : {}) }).set(...bearer(user.accessToken)).expect(200);
          expect(response.body.data.length).toBeLessThanOrEqual(limit);
          types.push(...response.body.data.map((row: { type: string }) => row.type));
          cursor = response.body.meta.nextCursor;
        } while (cursor);
        return types;
      };
      expect(await pages('OFFERS', 1)).toEqual(['offer.new', 'offer.countered']);
      expect(await pages('PROGRESS', 2)).toEqual([
        'assignment.accepted', 'execution.receipt_added', 'errand.completed.runner',
        'change_request.created', 'payment_agreement.updated', 'no_show.reported', 'errand.expired',
      ]);
      expect((await list(user, '?topic=OFFERS&unread=true')).map((row) => row.type)).toEqual(['offer.new']);
      expect((await list(user, '?topic=PROGRESS&category=MARKETPLACE')).map((row) => row.type))
        .toEqual(['execution.receipt_added', 'payment_agreement.updated', 'errand.expired']);
      expect((await list(user, '?category=TRANSACTIONAL')).map((row) => row.type)).toContain('account.password_changed');
      await request(app.getHttpServer()).get(`${API}/notifications?topic=UNKNOWN`).set(...bearer(user.accessToken)).expect(400);
    });

    it('lists newest first, counts unread, marks read one by one and all at once, and is private', async () => {
      const s = await selectedScene(app, categoryId);
      await dispatchOutbox(app);
      const stranger = await signedInUser(app);

      const all = await list(s.runner);
      expect(all.length).toBeGreaterThan(0);
      const count = async (user: Authed) =>
        (await request(app.getHttpServer()).get(`${API}/notifications/unread-count`).set(...bearer(user.accessToken)).expect(200)).body.data.count as number;
      const before = await count(s.runner);
      expect(before).toBe(all.length);

      const target = all[0];
      await request(app.getHttpServer()).post(`${API}/notifications/${target.id}/read`).set(...bearer(s.runner.accessToken)).expect(200);
      expect(await count(s.runner)).toBe(before - 1);
      expect((await list(s.runner, '?unread=true')).map((n) => n.id)).not.toContain(target.id);

      expect(
        (await request(app.getHttpServer()).post(`${API}/notifications/${target.id}/read`).set(...bearer(stranger.accessToken))).status,
      ).toBe(404);
      expect(await list(stranger)).toHaveLength(0);

      await request(app.getHttpServer()).post(`${API}/notifications/read-all`).set(...bearer(s.runner.accessToken)).expect(200);
      expect(await count(s.runner)).toBe(0);
    });
  });
});

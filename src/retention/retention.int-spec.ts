/**
 * P12-02: retention jobs (Backend PRD 29). Transient tables lose old rows; chat text is redacted
 * in place; a case that is still open (report, dispute, legal hold) keeps its errand's chat.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { completedScene } from '../test/assignment.helper.js';
import { RetentionService } from './retention.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Retention (P12-02)', () => {
  let app: INestApplication;
  let retention: RetentionService;
  const prisma = getTestPrisma();
  let categoryId: string;

  beforeAll(async () => {
    app = await createTestApp();
    retention = app.get(RetentionService);
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categoryId = (await seedCategories()).delivery;
  });
  afterAll(async () => {
    await app.close();
  });

  describe('transient tables', () => {
    it('removes notifications and their deliveries after 90 days and keeps newer ones', async () => {
      const user = await signedInUser(app);
      const make = async (ageDays: number) => {
        const created = await prisma.notification.create({
          data: { userId: user.userId, category: 'TRANSACTIONAL', type: 'test', title: 'T', body: 'B', createdAt: new Date(Date.now() - ageDays * 86_400_000) },
        });
        await prisma.notificationDelivery.create({ data: { notificationId: created.id, channel: 'IN_APP', status: 'SENT' } });
        return created.id;
      };
      const old = await make(91);
      const recent = await make(89);

      const result = await retention.purgeNotifications();
      expect(result).toEqual({ notifications: 1, notificationDeliveries: 1 });
      expect(await prisma.notification.findUnique({ where: { id: old } })).toBeNull();
      expect(await prisma.notificationDelivery.count({ where: { notificationId: old } })).toBe(0);
      expect(await prisma.notification.findUnique({ where: { id: recent } })).not.toBeNull();
      expect(await prisma.notificationDelivery.count({ where: { notificationId: recent } })).toBe(1);
    });

    it('removes published outbox events after a week, never a failed or recent one', async () => {
      const row = (status: 'PUBLISHED' | 'DEAD_LETTERED' | 'PENDING', ageDays: number) =>
        prisma.outboxEvent.create({
          data: {
            eventType: 'test.event',
            aggregateType: 'test',
            payload: {},
            status,
            processedAt: status === 'PENDING' ? null : new Date(Date.now() - ageDays * 86_400_000),
          },
        });
      const oldPublished = await row('PUBLISHED', 8);
      const recentPublished = await row('PUBLISHED', 1);
      const deadLetter = await row('DEAD_LETTERED', 30);
      const pending = await row('PENDING', 30);

      expect(await retention.purgeOutbox()).toBe(1);
      const left = (await prisma.outboxEvent.findMany({ select: { id: true } })).map((r) => r.id).sort();
      expect(left).toEqual([recentPublished.id, deadLetter.id, pending.id].sort());
      expect(left).not.toContain(oldPublished.id);
    });

    it('removes sessions that ended more than 30 days ago and never a live one', async () => {
      const ended = await signedInUser(app);
      const live = await signedInUser(app);
      await prisma.$executeRaw`UPDATE auth_sessions SET expires_at = now() - interval '31 days' WHERE user_id = ${ended.userId}::uuid`;
      const revoked = await signedInUser(app);
      await prisma.$executeRaw`UPDATE auth_sessions SET revoked_at = now() - interval '45 days' WHERE user_id = ${revoked.userId}::uuid`;

      expect(await retention.purgeSessions('auth_sessions')).toBe(2);
      expect(await prisma.authSession.count({ where: { userId: ended.userId } })).toBe(0);
      expect(await prisma.authSession.count({ where: { userId: revoked.userId } })).toBe(0);
      expect(await prisma.authSession.count({ where: { userId: live.userId } })).toBeGreaterThan(0);
    });

    it('removes offer counters older than a week and keeps today', async () => {
      const user = await signedInUser(app);
      const lagosDay = (offsetDays: number) =>
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(Date.now() + offsetDays * 86_400_000));
      await prisma.offerDailyCounter.createMany({
        data: [
          { userId: user.userId, dayLagos: lagosDay(-30), count: 5 },
          { userId: user.userId, dayLagos: lagosDay(-3), count: 2 },
          { userId: user.userId, dayLagos: lagosDay(0), count: 1 },
        ],
      });

      expect(await retention.purgeOfferCounters()).toBe(1);
      const left = (await prisma.offerDailyCounter.findMany({ select: { dayLagos: true } })).map((r) => r.dayLagos).sort();
      expect(left).toEqual([lagosDay(-3), lagosDay(0)].sort());
    });

    it('removes analytics events after 13 months', async () => {
      const at = (months: number) => new Date(Date.now() - months * 31 * 86_400_000);
      await prisma.analyticsEvent.createMany({
        data: [
          { name: 'USER_REGISTERED', occurredAt: at(14) },
          { name: 'ERRAND_CREATED', occurredAt: at(12) },
        ],
      });

      expect(await retention.purgeAnalytics()).toBe(1);
      expect((await prisma.analyticsEvent.findMany()).map((r) => r.name)).toEqual(['ERRAND_CREATED']);
    });

    it('works in batches: a batch of one removes one row and the next run removes the rest', async () => {
      const user = await signedInUser(app);
      await prisma.notification.createMany({
        data: [1, 2, 3].map(() => ({ userId: user.userId, category: 'TRANSACTIONAL' as const, type: 't', title: 'T', body: 'B', createdAt: new Date(Date.now() - 100 * 86_400_000) })),
      });
      expect((await retention.purgeNotifications(1)).notifications).toBe(1);
      expect((await retention.purgeNotifications(10)).notifications).toBe(2);
      expect((await retention.purgeNotifications(10)).notifications).toBe(0);
    });
  });

  describe('chat redaction', () => {
    /** A completed errand with two messages, finished `months` months ago. */
    async function chatScene(months: number) {
      const scene = await completedScene(app, categoryId);
      const conversation = await prisma.conversation.findFirstOrThrow({ where: { errandId: scene.errandId } });
      await prisma.$executeRaw`
        UPDATE errands SET completed_at = now() - make_interval(months => ${months}::int) WHERE id = ${scene.errandId}::uuid
      `;
      const message = await prisma.message.create({
        data: { conversationId: conversation.id, senderId: scene.runner.userId, type: 'TEXT', body: 'Call me on 08030000000' },
      });
      const system = await prisma.message.create({
        data: { conversationId: conversation.id, senderId: scene.runner.userId, type: 'SYSTEM', body: 'Runner arrived' },
      });
      return { ...scene, conversationId: conversation.id, messageId: message.id, systemId: system.id };
    }

    it('redacts the text and keeps the row, 12 months after the errand ended', async () => {
      const old = await chatScene(13);
      const young = await chatScene(11);

      expect(await retention.redactMessages()).toBeGreaterThanOrEqual(2);
      expect(await countOldChat(old.conversationId)).toBe(0);
      expect(await countOldChat(young.conversationId)).toBeGreaterThanOrEqual(2);
      const redacted = await prisma.message.findUniqueOrThrow({ where: { id: old.messageId } });
      expect(redacted).toMatchObject({ body: null, status: 'REMOVED', removalReason: 'RETENTION' });
      expect(redacted.removedAt).not.toBeNull();
      const system = await prisma.message.findUniqueOrThrow({ where: { id: old.systemId } });
      expect(system).toMatchObject({ body: '', status: 'REMOVED' });
      expect((await prisma.message.findUniqueOrThrow({ where: { id: young.messageId } })).body).toBe('Call me on 08030000000');

      // A second run finds nothing more.
      expect(await retention.redactMessages()).toBe(0);
    });

    it('keeps the chat while a report, a dispute or a legal hold is open, and redacts it once released', async () => {
      const reported = await chatScene(14);
      const disputed = await chatScene(14);
      const legal = await chatScene(14);

      await prisma.report.create({
        data: {
          reporterId: reported.requester.userId,
          targetType: 'ERRAND',
          errandId: reported.errandId,
          type: 'ERRAND',
          description: 'Looks wrong',
          retentionHold: true,
        },
      });
      await prisma.dispute.create({
        data: {
          errandId: disputed.errandId,
          assignmentId: disputed.assignmentId,
          openedBy: disputed.requester.userId,
          type: 'ITEM_DAMAGED',
          claim: 'Broken',
        },
      });
      await prisma.$executeRaw`UPDATE errands SET legal_hold = TRUE WHERE id = ${legal.errandId}::uuid`;

      await retention.redactMessages();
      for (const held of [reported, disputed, legal]) {
        expect((await prisma.message.findUniqueOrThrow({ where: { id: held.messageId } })).body, held.errandId).toBe('Call me on 08030000000');
      }

      // The hold ends: the report is resolved, the dispute is decided, the legal hold is lifted.
      await prisma.$executeRaw`UPDATE reports SET retention_hold = FALSE WHERE errand_id = ${reported.errandId}::uuid`;
      await prisma.$executeRaw`UPDATE disputes SET retention_hold = FALSE WHERE errand_id = ${disputed.errandId}::uuid`;
      await prisma.$executeRaw`UPDATE errands SET legal_hold = FALSE WHERE id = ${legal.errandId}::uuid`;
      await retention.redactMessages();
      for (const released of [reported, disputed, legal]) {
        expect((await prisma.message.findUniqueOrThrow({ where: { id: released.messageId } })).body, released.errandId).toBeNull();
      }
    });

    async function countOldChat(conversationId: string): Promise<number> {
      return prisma.message.count({ where: { conversationId, status: { not: 'REMOVED' } } });
    }
  });

  it('runs every rule in one pass and reports what it did', async () => {
    const report = await retention.runAll();
    expect(Object.keys(report).sort()).toEqual(
      ['adminSessions', 'analyticsEvents', 'authSessions', 'messagesRedacted', 'notificationDeliveries', 'notifications', 'offerDailyCounters', 'outboxEvents'].sort(),
    );
    expect(Object.values(report).every((n) => n === 0)).toBe(true);
  });
});

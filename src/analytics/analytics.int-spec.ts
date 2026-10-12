/**
 * P12-03: business events for analytics (Backend PRD 28.2). The events come from the outbox, one
 * row per source event, and carry no address, phone number or message text.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { seedPolicies, signedInUser } from '../test/auth.helper.js';
import { createDraft, draftBody, seedCategories } from '../test/errand.helper.js';
import { completedScene } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { AnalyticsEventHandler } from './analytics-event.handler.js';
import { AnalyticsService, ANALYTICS_EVENT_NAMES, cleanProperties } from './analytics.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

/** Every property key an event may carry. A new key has to be added here on purpose. */
const ALLOWED_KEYS = new Set([
  'method',
  'categoryId',
  'priority',
  'amountMinor',
  'durationMinutes',
  'agreedAmountMinor',
  'actorType',
  'from',
  'extended',
  'type',
  'targetType',
]);

describe('Analytics events (P12-03)', () => {
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

  const names = async () => (await prisma.analyticsEvent.findMany({ select: { name: true } })).map((row) => row.name);

  it('records the errand journey from registration to completion, once per source event', async () => {
    const requester = await signedInUser(app);
    await createDraft(app, requester, draftBody(categoryId)).expect(201);
    await completedScene(app, categoryId, { requester });
    await dispatchOutbox(app);

    const recorded = await names();
    for (const expected of [
      'USER_REGISTERED',
      'ERRAND_CREATED',
      'USER_VERIFIED',
      'OFFER_CREATED',
      'OFFER_SELECTED',
      'ASSIGNMENT_ACCEPTED',
      'ERRAND_STARTED',
      'ERRAND_DELIVERED',
      'ERRAND_COMPLETED',
    ]) {
      expect(recorded, expected).toContain(expected);
    }
    expect(recorded.every((name) => (ANALYTICS_EVENT_NAMES as readonly string[]).includes(name))).toBe(true);

    // The same outbox events delivered again write nothing new.
    const before = await prisma.analyticsEvent.count();
    const handler = app.get(AnalyticsEventHandler);
    const rows = await prisma.outboxEvent.findMany();
    for (const row of rows) {
      await handler.handle({
        eventId: row.id,
        eventType: row.eventType,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        payload: row.payload as Record<string, unknown>,
        occurredAt: row.occurredAt,
      });
    }
    expect(await prisma.analyticsEvent.count()).toBe(before);
  });

  it('keeps only whitelisted, non-personal properties on every row', async () => {
    const requester = await signedInUser(app);
    await createDraft(app, requester, draftBody(categoryId)).expect(201);
    await completedScene(app, categoryId, { requester });
    await dispatchOutbox(app);

    const rows = await prisma.analyticsEvent.findMany();
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      for (const key of Object.keys(row.properties as Record<string, unknown>)) {
        expect(ALLOWED_KEYS.has(key), `${row.name} carries ${key}`).toBe(true);
      }
    }
    const everything = JSON.stringify(rows);
    expect(everything).not.toMatch(/\+?234\d{10}/);
    expect(everything).not.toMatch(/@/);
  });

  it('records reports, disputes, a purchased pro plan and a boost, and ignores an admin grant', async () => {
    const handler = app.get(AnalyticsEventHandler);
    const at = new Date();
    const send = (eventType: string, payload: Record<string, unknown>) =>
      handler.handle({ eventId: randomUUID(), eventType, aggregateType: null, aggregateId: null, payload, occurredAt: at });
    const user = randomUUID();

    await send('report.created', { reporterId: user, type: 'HARASSMENT', targetType: 'USER', description: '0803 000 0000 abuse text' });
    await send('dispute.created', { openedBy: user, errandId: randomUUID(), type: 'ITEM_NOT_DELIVERED' });
    await send('subscription.activated', { userId: user, orderId: randomUUID(), extended: false });
    await send('subscription.activated', { userId: user, orderId: null, byAdmin: true });
    await send('boost.activated', { userId: user, errandId: randomUUID() });

    expect((await names()).sort()).toEqual(['BOOST_PURCHASED', 'DISPUTE_CREATED', 'REPORT_CREATED', 'RUNNER_PRO_PURCHASED']);
    const report = await prisma.analyticsEvent.findFirstOrThrow({ where: { name: 'REPORT_CREATED' } });
    expect(JSON.stringify(report.properties)).not.toContain('abuse');
  });

  it('drops properties whose names or values could carry personal text', () => {
    expect(
      cleanProperties({
        amountMinor: 50_000,
        method: 'EMAIL',
        pickupAddress: '12 Allen Avenue',
        phone: '+2348030000000',
        messageBody: 'hello',
        note: 'x',
        nested: { a: 1 },
        long: 'x'.repeat(200),
      }),
    ).toEqual({ amountMinor: 50_000, method: 'EMAIL' });
  });

  it('writes a row directly through the service and ignores a repeated source event', async () => {
    const service = app.get(AnalyticsService);
    const source = randomUUID();
    expect(await service.record({ name: 'USER_REGISTERED', sourceEventId: source, properties: { method: 'EMAIL' } })).toBe(true);
    expect(await service.record({ name: 'USER_REGISTERED', sourceEventId: source })).toBe(false);
    expect(await prisma.analyticsEvent.count()).toBe(1);
  });
});

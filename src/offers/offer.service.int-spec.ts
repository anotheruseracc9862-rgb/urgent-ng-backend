/**
 * P6-04 integration tests: Offer submission with database persistence
 *
 * Verifies:
 * - Failed offer doesn't increment counter (transaction rollback)
 * - Expired errand rejected without counting
 * - Outbox event created in same transaction
 * - errand.offer_count incremented
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { seedPolicies, signedInUser, type TestUser } from '../test/auth.helper.js';
import { OfferService } from './offer.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('OfferService integration (P6-04)', () => {
  let app: INestApplication;
  let service: OfferService;
  const prisma = getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
    service = app.get(OfferService);
  });

  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rolls back transaction on validation error without incrementing counter', async () => {
    const requester = await signedInUser(app);
    const runner = await signedInUser(app);
    
    const category = await prisma.category.create({
      data: {
        key: 'delivery-test',
        name: 'Delivery Test',
        requiresPickup: true,
        requiresDestination: true,
      },
    });

    const errand = await prisma.errand.create({
      data: {
        requesterId: requester.userId,
        categoryId: category.id,
        title: 'Test Errand',
        description: 'Test description',
        status: 'OPEN',
        timeMode: 'ASAP',
        publishedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const counterBefore = await prisma.offerDailyCounter.findUnique({
      where: {
        userId_dayLagos: {
          userId: runner.userId,
          dayLagos: new Date().toISOString().split('T')[0],
        },
      },
    });

    expect(counterBefore).toBeNull();

    // Attempt to submit offer with invalid amount (below minimum of 20000)
    await expect(
      service.submitOffer({
        errand: { id: errand.id, requesterId: requester.userId, status: 'OPEN' },
        runnerId: runner.userId,
        amountMinor: 100, // too low
        durationMinutes: 30,
        availabilityConfirmedAt: new Date(),
      }),
    ).rejects.toThrow();

    // Verify counter was NOT incremented
    const counterAfter = await prisma.offerDailyCounter.findUnique({
      where: {
        userId_dayLagos: {
          userId: runner.userId,
          dayLagos: new Date().toISOString().split('T')[0],
        },
      },
    });

    expect(counterAfter).toBeNull();

    // Verify no offer was created
    const offers = await prisma.offer.count({ where: { errandId: errand.id } });
    expect(offers).toBe(0);

    // Verify no outbox event was created
    const events = await prisma.outboxEvent.count({ where: { eventType: 'offer.submitted' } });
    expect(events).toBe(0);

    // Verify errand.offer_count was NOT incremented
    const updatedErrand = await prisma.errand.findUnique({ where: { id: errand.id } });
    expect(updatedErrand?.offerCount).toBe(0);
  });

  it('rejects expired errand without counting against limit', async () => {
    const requester = await signedInUser(app);
    const runner = await signedInUser(app);
    
    const category = await prisma.category.create({
      data: {
        key: 'delivery-test2',
        name: 'Delivery Test 2',
        requiresPickup: true,
        requiresDestination: true,
      },
    });

    // Create an expired errand
    const errandId = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO errands (
        requester_id, category_id, title, description, status, time_mode, priority,
        published_at, expires_at, updated_at
      ) VALUES (
        ${requester.userId}::uuid, ${category.id}::uuid, 'Expired Errand', 'Test description',
        'EXPIRED'::"ErrandStatus", 'ASAP'::"TimeMode", 'URGENT'::"ErrandPriority",
        NOW() - INTERVAL '48 hours', NOW() - INTERVAL '1 hour',
        NOW()
      ) RETURNING id::text
    `.then((rows) => rows[0].id);

    const errand = await prisma.errand.findUniqueOrThrow({ where: { id: errandId } });

    const counterBefore = await prisma.offerDailyCounter.findUnique({
      where: {
        userId_dayLagos: {
          userId: runner.userId,
          dayLagos: new Date().toISOString().split('T')[0],
        },
      },
    });

    expect(counterBefore).toBeNull();

    // Attempt to submit offer on expired errand
    await expect(
      service.submitOffer({
        errand: { id: errand.id, requesterId: requester.userId, status: 'EXPIRED' },
        runnerId: runner.userId,
        amountMinor: 50000,
        durationMinutes: 30,
        availabilityConfirmedAt: new Date(),
      }),
    ).rejects.toThrow();

    // Verify counter was NOT incremented
    const counterAfter = await prisma.offerDailyCounter.findUnique({
      where: {
        userId_dayLagos: {
          userId: runner.userId,
          dayLagos: new Date().toISOString().split('T')[0],
        },
      },
    });

    expect(counterAfter).toBeNull();

    // Verify no offer was created
    const offers = await prisma.offer.count({ where: { errandId: errand.id } });
    expect(offers).toBe(0);

    // Verify errand.offer_count was NOT incremented
    const updatedErrand = await prisma.errand.findUnique({ where: { id: errand.id } });
    expect(updatedErrand?.offerCount).toBe(0);
  });

  it('creates outbox event and increments offer_count in same transaction', async () => {
    const requester = await signedInUser(app);
    const runner = await signedInUser(app);
    
    const category = await prisma.category.create({
      data: {
        key: 'delivery-test3',
        name: 'Delivery Test 3',
        requiresPickup: true,
        requiresDestination: true,
      },
    });

    // Create errand with proper schema constraints
    const errandId = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO errands (
        requester_id, category_id, title, description, status, time_mode, priority,
        published_at, expires_at, feed_point, updated_at
      ) VALUES (
        ${requester.userId}::uuid, ${category.id}::uuid, 'Test Errand', 'Test description',
        'OPEN'::"ErrandStatus", 'ASAP'::"TimeMode", 'URGENT'::"ErrandPriority",
        NOW(), NOW() + INTERVAL '24 hours',
        ST_SetSRID(ST_MakePoint(3.3792, 6.5244), 4326)::geography,
        NOW()
      ) RETURNING id::text
    `.then((rows) => rows[0].id);

    const errand = await prisma.errand.findUniqueOrThrow({ where: { id: errandId } });

    const offer = await service.submitOffer({
      errand: { id: errand.id, requesterId: requester.userId, status: 'OPEN' },
      runnerId: runner.userId,
      amountMinor: 50000,
      durationMinutes: 30,
      availabilityConfirmedAt: new Date(),
      message: 'Test offer',
    });

    expect(offer.id).toBeDefined();
    expect(offer.status).toBe('ACTIVE');

    // Verify counter was incremented
    const counter = await prisma.offerDailyCounter.findUnique({
      where: {
        userId_dayLagos: {
          userId: runner.userId,
          dayLagos: new Date().toISOString().split('T')[0],
        },
      },
    });

    expect(counter?.count).toBe(1);

    // Verify outbox event was created
    const event = await prisma.outboxEvent.findFirst({
      where: {
        eventType: 'offer.submitted',
        aggregateId: offer.id,
      },
    });

    expect(event).toBeDefined();
    expect(event?.payload).toMatchObject({
      offerId: offer.id,
      errandId: errand.id,
      runnerId: runner.userId,
      requesterId: requester.userId,
      amountMinor: 50000,
      durationMinutes: 30,
    });

    // Verify errand.offer_count was incremented
    const updatedErrand = await prisma.errand.findUnique({ where: { id: errand.id } });
    expect(updatedErrand?.offerCount).toBe(1);

    // Verify negotiation event was created
    const negotiationEvent = await prisma.negotiationEvent.findFirst({
      where: { offerId: offer.id },
    });

    expect(negotiationEvent).toBeDefined();
    expect(negotiationEvent?.messageType).toBe('INITIAL_OFFER');
  });
});

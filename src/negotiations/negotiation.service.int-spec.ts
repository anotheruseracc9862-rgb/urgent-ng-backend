/**
 * P6-05 integration tests: Negotiation turn rules and immutability
 *
 * Verifies:
 * - Turn-based negotiation (REQUESTER → RUNNER → REQUESTER)
 * - Price history reconstruction from negotiation_events
 * - Negotiation events are immutable (UPDATE/DELETE blocked)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { seedPolicies, signedInUser } from '../test/auth.helper.js';
import { OfferService } from '../offers/offer.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Negotiation integration (P6-05)', () => {
  let app: INestApplication;
  let offerService: OfferService;
  const prisma = getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
    offerService = app.get(OfferService);
  });

  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createErrand(requesterId: string, categoryId: string) {
    // Use raw SQL to create errand with feed_point
    const id = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO errands (
        requester_id, category_id, title, description, status, time_mode, priority,
        published_at, expires_at, feed_point, updated_at
      ) VALUES (
        ${requesterId}::uuid, ${categoryId}::uuid, 'Test Errand', 'Test description',
        'OPEN'::"ErrandStatus", 'ASAP'::"TimeMode", 'URGENT'::"ErrandPriority",
        NOW(), NOW() + INTERVAL '24 hours',
        ST_SetSRID(ST_MakePoint(3.3792, 6.5244), 4326)::geography,
        NOW()
      ) RETURNING id::text
    `.then((rows) => rows[0].id);

    return await prisma.errand.findUniqueOrThrow({ where: { id } });
  }

  async function createCategory(key: string) {
    return await prisma.category.create({
      data: {
        key,
        name: `Test Category ${key}`,
        requiresPickup: true,
        requiresDestination: true,
      },
    });
  }

  it('runner submits offer → awaitingParty === REQUESTER', async () => {
    const requester = await signedInUser(app);
    const runner = await signedInUser(app);
    const category = await createCategory('delivery-test1');
    const errand = await createErrand(requester.userId, category.id);

    const offer = await offerService.submitOffer({
      errand: { id: errand.id, requesterId: requester.userId, status: 'OPEN' },
      runnerId: runner.userId,
      amountMinor: 50000,
      durationMinutes: 30,
      availabilityConfirmedAt: new Date(),
    });

    expect(offer.awaitingParty).toBe('REQUESTER');
    expect(offer.status).toBe('ACTIVE');

    const negotiationEvents = await prisma.negotiationEvent.findMany({
      where: { offerId: offer.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(negotiationEvents.length).toBe(1);
    expect(negotiationEvents[0].messageType).toBe('INITIAL_OFFER');
    expect(negotiationEvents[0].actorUserId).toBe(runner.userId);
  });

  it('requester counters → awaitingParty === RUNNER', async () => {
    const requester = await signedInUser(app);
    const runner = await signedInUser(app);
    const category = await createCategory('delivery-test2');
    const errand = await createErrand(requester.userId, category.id);

    const offer = await offerService.submitOffer({
      errand: { id: errand.id, requesterId: requester.userId, status: 'OPEN' },
      runnerId: runner.userId,
      amountMinor: 50000,
      durationMinutes: 30,
      availabilityConfirmedAt: new Date(),
    });

    const countered = await offerService.counterOffer(
      offer.id,
      'REQUESTER',
      45000,
      25,
      'Can you do it for less?',
      offer.version,
    );

    expect(countered.awaitingParty).toBe('RUNNER');
    expect(countered.amountMinor).toBe(45000);
    expect(countered.durationMinutes).toBe(25);
    expect(countered.version).toBe(2);

    const negotiationEvents = await prisma.negotiationEvent.findMany({
      where: { offerId: offer.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(negotiationEvents.length).toBe(2);
    expect(negotiationEvents[1].messageType).toBe('COUNTER_OFFER');
    expect(negotiationEvents[1].actorUserId).toBe(requester.userId);
    expect(Number(negotiationEvents[1].proposedAmountMinor)).toBe(45000);
  });

  it('runner tries to counter again immediately → throws OFFER_INVALID_STATE', async () => {
    const requester = await signedInUser(app);
    const runner = await signedInUser(app);
    const category = await createCategory('delivery-test3');
    const errand = await createErrand(requester.userId, category.id);

    const offer = await offerService.submitOffer({
      errand: { id: errand.id, requesterId: requester.userId, status: 'OPEN' },
      runnerId: runner.userId,
      amountMinor: 50000,
      durationMinutes: 30,
      availabilityConfirmedAt: new Date(),
    });

    // It's REQUESTER's turn, so runner cannot counter immediately
    await expect(
      offerService.counterOffer(offer.id, 'RUNNER', 48000, 28, undefined, offer.version),
    ).rejects.toThrow();
  });

  it('accept final counter → offer status SELECTED, awaitingParty NONE', async () => {
    const requester = await signedInUser(app);
    const runner = await signedInUser(app);
    const category = await createCategory('delivery-test4');
    const errand = await createErrand(requester.userId, category.id);

    const offer = await offerService.submitOffer({
      errand: { id: errand.id, requesterId: requester.userId, status: 'OPEN' },
      runnerId: runner.userId,
      amountMinor: 50000,
      durationMinutes: 30,
      availabilityConfirmedAt: new Date(),
    });

    const countered = await offerService.counterOffer(
      offer.id,
      'REQUESTER',
      45000,
      25,
      undefined,
      offer.version,
    );

    const accepted = await offerService.acceptOffer(offer.id, countered.version);

    expect(accepted.status).toBe('SELECTED');
    expect(accepted.awaitingParty).toBe('NONE');
    expect(accepted.closeReason).toBe('RUNNER_SELECTED');
  });

  it('reconstruct price path from negotiation_events: [5000, 4500, 4750, accept]', async () => {
    const requester = await signedInUser(app);
    const runner = await signedInUser(app);
    const category = await createCategory('delivery-test5');
    const errand = await createErrand(requester.userId, category.id);

    // Initial offer: 5000
    const offer = await offerService.submitOffer({
      errand: { id: errand.id, requesterId: requester.userId, status: 'OPEN' },
      runnerId: runner.userId,
      amountMinor: 50000,
      durationMinutes: 30,
      availabilityConfirmedAt: new Date(),
    });

    // Requester counters: 4500
    const counter1 = await offerService.counterOffer(
      offer.id,
      'REQUESTER',
      45000,
      25,
      'Lower',
      offer.version,
    );

    // Runner counters: 4750
    const counter2 = await offerService.counterOffer(
      counter1.id,
      'RUNNER',
      47500,
      28,
      'Meet in middle',
      counter1.version,
    );

    // Requester accepts
    await offerService.acceptOffer(offer.id, counter2.version);

    const negotiationEvents = await prisma.negotiationEvent.findMany({
      where: { offerId: offer.id },
      orderBy: { createdAt: 'asc' },
    });

    const pricePath = negotiationEvents.map((e) =>
      e.proposedAmountMinor ? Number(e.proposedAmountMinor) : null,
    );

    expect(pricePath).toEqual([50000, 45000, 47500]);
    expect(negotiationEvents.length).toBe(3);
    expect(negotiationEvents[0].messageType).toBe('INITIAL_OFFER');
    expect(negotiationEvents[1].messageType).toBe('COUNTER_OFFER');
    expect(negotiationEvents[2].messageType).toBe('COUNTER_OFFER');
  });

  it('attempt UPDATE on negotiation_events directly → database rejects', async () => {
    const requester = await signedInUser(app);
    const runner = await signedInUser(app);
    const category = await createCategory('delivery-test6');
    const errand = await createErrand(requester.userId, category.id);

    const offer = await offerService.submitOffer({
      errand: { id: errand.id, requesterId: requester.userId, status: 'OPEN' },
      runnerId: runner.userId,
      amountMinor: 50000,
      durationMinutes: 30,
      availabilityConfirmedAt: new Date(),
    });

    const negotiationEvent = await prisma.negotiationEvent.findFirst({
      where: { offerId: offer.id },
    });

    expect(negotiationEvent).toBeDefined();

    // Attempt to UPDATE negotiation_events should fail
    await expect(
      prisma.$executeRaw`
        UPDATE negotiation_events 
        SET proposed_amount_minor = 99999 
        WHERE id = ${negotiationEvent!.id}::uuid
      `,
    ).rejects.toThrow();

    // Attempt to DELETE negotiation_events should also fail
    await expect(
      prisma.$executeRaw`
        DELETE FROM negotiation_events 
        WHERE id = ${negotiationEvent!.id}::uuid
      `,
    ).rejects.toThrow();

    // Verify the event is unchanged
    const unchanged = await prisma.negotiationEvent.findUnique({
      where: { id: negotiationEvent!.id },
    });
    expect(Number(unchanged?.proposedAmountMinor)).toBe(50000);
  });
});

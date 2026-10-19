/**
 * P6-05 integration tests: turn rules, the immutable negotiation history, version checks.
 * Everything goes through the HTTP API against real PostgreSQL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { seedPolicies, signedInUser } from '../test/auth.helper.js';
import { readyRunner } from '../test/verification.helper.js';
import { insertErrand, seedCategories } from '../test/errand.helper.js';
import { offerAction, submitOffer } from '../test/offer.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Negotiation (P6-05)', () => {
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

  async function setup() {
    const requester = await signedInUser(app);
    const runner = await readyRunner(app);
    const stranger = await signedInUser(app);
    const errandId = await insertErrand({ requesterId: requester.userId, categoryId });
    const offer = (await submitOffer(app, runner, errandId).expect(201)).body.data;
    return { requester, runner, stranger, errandId, offer };
  }
  const events = async (offerId: string) =>
    (await prisma.negotiationEvent.findMany({ where: { offerId }, orderBy: { createdAt: 'asc' } })).map((e) => ({
      type: e.messageType,
      actor: e.actorUserId,
      amount: e.proposedAmountMinor === null ? null : Number(e.proposedAmountMinor),
      version: e.resultingOfferVersion,
    }));

  it('follows the turns: counter, runner counters back, runner accepts, requester can select', async () => {
    const { requester, runner, offer } = await setup();

    const c1 = await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 45_000, durationMinutes: 25 }).expect(200);
    expect(c1.body.data).toMatchObject({ awaitingParty: 'RUNNER', amountMinor: 45_000 });

    // requester cannot counter twice in a row
    expect((await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 40_000, durationMinutes: 25 })).body.error.code).toBe('OFFER_INVALID_STATE');

    const c2 = await offerAction(app, runner, 'post', offer.id, 'counter', { amountMinor: 47_500, durationMinutes: 30 }).expect(200);
    expect(c2.body.data.awaitingParty).toBe('REQUESTER');

    const c3 = await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 46_000, durationMinutes: 30 }).expect(200);
    const agreed = await offerAction(app, runner, 'post', offer.id, 'accept-counter', { expectedVersion: c3.body.data.version }).expect(200);

    expect(agreed.body.data).toMatchObject({ status: 'ACTIVE', awaitingParty: 'NONE', amountMinor: 46_000 });
    const history = await events(offer.id);
    expect(history.map((e) => e.type)).toEqual(['INITIAL_OFFER', 'COUNTER_OFFER', 'COUNTER_OFFER', 'COUNTER_OFFER', 'ACCEPT']);
    expect(history.map((e) => e.amount)).toEqual([50_000, 45_000, 47_500, 46_000, 46_000]);
    expect(history.map((e) => e.version)).toEqual([0, 1, 2, 3, 4]);
    expect(history[1].actor).toBe(requester.userId);
    expect(history[4].actor).toBe(runner.userId);
  });

  it('lets the runner edit their own offer while it waits on the requester, and not while it waits on them', async () => {
    const { requester, runner, offer } = await setup();

    const edited = await offerAction(app, runner, 'patch', offer.id, '', { amountMinor: 48_000, durationMinutes: 20 }).expect(200);
    expect(edited.body.data).toMatchObject({ amountMinor: 48_000, awaitingParty: 'REQUESTER' });

    await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 40_000, durationMinutes: 20 }).expect(200);
    const blocked = await offerAction(app, runner, 'patch', offer.id, '', { amountMinor: 41_000, durationMinutes: 20 });
    expect(blocked.status).toBe(409);
    // an edit is not a daily-limit event
    const count = (await prisma.offerDailyCounter.findMany({ where: { userId: runner.userId } })).reduce((n, c) => n + c.count, 0);
    expect(count).toBe(1);
  });

  it('stops counters after the round limit: then it is accept or decline, and edits never count', async () => {
    const { requester, runner, offer } = await setup();

    // A runner's edit before any counter is not a round.
    await offerAction(app, runner, 'patch', offer.id, '', { amountMinor: 49_000, durationMinutes: 30 }).expect(200);
    let negotiation = (await offerAction(app, runner, 'get', offer.id, '')).body.data;
    expect(negotiation).toMatchObject({ roundsUsed: 0, roundsLimit: 6 });

    // Six counters, alternating, starting with the requester.
    for (let round = 1; round <= 6; round += 1) {
      const actor = round % 2 === 1 ? requester : runner;
      await offerAction(app, actor, 'post', offer.id, 'counter', { amountMinor: 48_000 - round * 500, durationMinutes: 30 }).expect(200);
    }
    negotiation = (await offerAction(app, requester, 'get', offer.id, '')).body.data;
    expect(negotiation).toMatchObject({ roundsUsed: 6, roundsLimit: 6, awaitingParty: 'REQUESTER' });

    // The seventh counter is refused with the reason, and nothing changes.
    const refused = await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 40_000, durationMinutes: 30 });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'OFFER_ROUND_LIMIT_REACHED', details: { roundsUsed: 6, roundsLimit: 6 } });
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).counterRounds).toBe(6);

    // The requester can still decline. (Selecting the runner at these terms is covered by the selection tests.)
    await offerAction(app, requester, 'post', offer.id, 'reject', { expectedVersion: negotiation.version }).expect(200);
  });

  it('keeps counters inside the amount and duration bounds', async () => {
    const { requester, offer } = await setup();
    expect((await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 1, durationMinutes: 30 })).status).toBe(400);
    expect((await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 40_000, durationMinutes: 9_999 })).status).toBe(400);
    expect(await events(offer.id)).toHaveLength(1);
  });

  it('accept-counter is the runner\'s, and only when a counter is waiting', async () => {
    const { requester, runner, offer } = await setup();
    expect((await offerAction(app, runner, 'post', offer.id, 'accept-counter')).status).toBe(409);
    await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 45_000, durationMinutes: 30 }).expect(200);
    expect((await offerAction(app, requester, 'post', offer.id, 'accept-counter')).status).toBe(403);
    await offerAction(app, runner, 'post', offer.id, 'accept-counter').expect(200);
  });

  it('the requester can reject at any point before selection; the runner cannot', async () => {
    const { requester, runner, offer } = await setup();
    await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 45_000, durationMinutes: 30 }).expect(200);

    expect((await offerAction(app, runner, 'post', offer.id, 'reject')).status).toBe(403);
    const rejected = await offerAction(app, requester, 'post', offer.id, 'reject').expect(200);

    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', closeReason: 'REQUESTER_REJECTED', awaitingParty: 'NONE' });
    const row = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(row.closedAt).not.toBeNull();
    expect((await events(offer.id)).at(-1)?.type).toBe('REJECT');
    expect((await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 40_000, durationMinutes: 30 })).status).toBe(409);
  });

  it('a withdrawn offer is recorded, still counts for the day, and cannot be revived', async () => {
    const { runner, requester, errandId, offer } = await setup();

    const res = await offerAction(app, runner, 'post', offer.id, 'withdraw').expect(200);

    expect(res.body.data).toMatchObject({ status: 'WITHDRAWN', closeReason: 'RUNNER_WITHDREW' });
    const row = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(row.withdrawnAt).not.toBeNull();
    expect(row.closedAt).not.toBeNull();
    expect((await events(offer.id)).at(-1)?.type).toBe('WITHDRAW');
    expect((await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 40_000, durationMinutes: 30 })).status).toBe(409);
    expect((await prisma.offerDailyCounter.findMany({ where: { userId: runner.userId } })).reduce((n, c) => n + c.count, 0)).toBe(1);
    // resubmitting works but is a second counted offer
    await submitOffer(app, runner, errandId).expect(201);
    expect((await prisma.offerDailyCounter.findMany({ where: { userId: runner.userId } })).reduce((n, c) => n + c.count, 0)).toBe(2);
  });

  it('answers a stranger exactly like a missing offer', async () => {
    const { stranger, offer } = await setup();
    const missing = '01a12638-0000-7000-8000-000000000000';
    for (const action of ['counter', 'accept-counter', 'withdraw', 'reject', 'reconfirm']) {
      const body = action === 'counter' ? { amountMinor: 40_000, durationMinutes: 30 } : {};
      const real = await offerAction(app, stranger, 'post', offer.id, action, body);
      const none = await offerAction(app, stranger, 'post', missing, action, body);
      expect(real.status).toBe(404);
      expect(none.status).toBe(404);
    }
  });

  it('rejects a stale version with OFFER_VERSION_MISMATCH', async () => {
    const { requester, runner, offer } = await setup();
    await offerAction(app, runner, 'patch', offer.id, '', { amountMinor: 49_000, durationMinutes: 30 }).expect(200);

    const stale = await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 40_000, durationMinutes: 30, expectedVersion: offer.version });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('OFFER_VERSION_MISMATCH');
  });

  it('two simultaneous counters from the same turn produce exactly one', async () => {
    const { requester, offer } = await setup();
    const results = await Promise.all(
      [40_000, 41_000, 42_000, 43_000].map((amountMinor) =>
        offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor, durationMinutes: 30 }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await events(offer.id)).toHaveLength(2);
  });

  it('negotiation events cannot be updated or deleted, even with raw SQL', async () => {
    const { offer } = await setup();
    await expect(prisma.$executeRaw`UPDATE negotiation_events SET message = 'x' WHERE offer_id = ${offer.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM negotiation_events WHERE offer_id = ${offer.id}::uuid`).rejects.toThrow();
  });

  it('the database refuses an offer whose parties do not match the errand', async () => {
    const { requester, runner, stranger, errandId } = await setup();
    await expect(
      prisma.$executeRaw`
        INSERT INTO offers (errand_id, runner_id, requester_id, amount_minor, duration_minutes, status, awaiting_party, updated_at)
        VALUES (${errandId}::uuid, ${stranger.userId}::uuid, ${runner.userId}::uuid, 50000, 30, 'WITHDRAWN', 'NONE', now())`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`
        INSERT INTO offers (errand_id, runner_id, requester_id, amount_minor, duration_minutes, status, awaiting_party, updated_at)
        VALUES (${errandId}::uuid, ${requester.userId}::uuid, ${requester.userId}::uuid, 50000, 30, 'WITHDRAWN', 'NONE', now())`,
    ).rejects.toThrow();
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ErrandStatus, type Prisma } from '@prisma/client';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { seedPolicies, signedInUser } from '../test/auth.helper.js';
import { insertErrand, seedCategories } from '../test/errand.helper.js';
import { ErrandStateService, type TransitionInput } from './errand-state.service.js';
import { ERRAND_TRANSITIONS, type ErrandActor } from './errand.state.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('ErrandStateService (P5-03)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let requesterId: string;
  let categoryId: string;
  const service = () => app.get(ErrandStateService);

  const run = (input: TransitionInput) => prisma.$transaction((tx) => service().transition(tx, input));
  const row = async (id: string) =>
    (
      await prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT status::text AS status, status_before_dispute::text AS before, version, expires_at, auto_complete_at,
               delivered_at, completed_at, cancelled_at, cancellation_reason::text AS reason, cancelled_by_type::text AS by_type
        FROM errands WHERE id = ${id}::uuid`
    )[0];
  const make = (status: ErrandStatus, extra = {}) => insertErrand({ requesterId, categoryId, status, ...extra });

  beforeAll(async () => {
    app = await createTestApp();
    await cleanAll();
    await seedPolicies();
    categoryId = (await seedCategories()).delivery;
    requesterId = (await signedInUser(app)).userId;
  });
  // The user and category are made once; every test starts from no errands and no event rows.
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE errands, outbox_events, audit_logs RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await app.close();
  });

  /** What the publish action writes before the status changes (an OPEN errand needs these). */
  const publishFields = (id: string) => async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`UPDATE errands SET time_mode = 'ASAP', priority = 'URGENT', published_at = now(), expires_at = now() + interval '24 hours', prohibited_items_confirmed_at = now() WHERE id = ${id}::uuid`;
  };

  /** A status each transition row can start from, built with the fields that status needs. */
  const startFor = (from: ErrandStatus, to: ErrandStatus) =>
    make(from, from === 'DISPUTED' ? { statusBeforeDispute: to === 'COMPLETED' || to === 'CANCELLED' ? 'DELIVERED' : to } : {});

  describe('every row of the table', () => {
    for (const transition of ERRAND_TRANSITIONS) {
      for (const actor of transition.actors) {
        it(`${transition.from} -> ${transition.to} by ${actor}`, async () => {
          const id = await startFor(transition.from, transition.to);
          const result = await run({
            errandId: id,
            to: transition.to,
            actor: { type: actor, id: actor === 'SYSTEM' ? undefined : requesterId },
            cancellation: transition.needsCancellation ? { reason: 'REQUESTER_CANCELLED', note: 'changed my mind' } : undefined,
            apply: transition.from === 'DRAFT' && transition.to === 'OPEN' ? publishFields(id) : undefined,
          });

          // A reopening keeps its target unless the deadline rules end the errand.
          expect(result.to).toBe(transition.to);
          const after = await row(id);
          expect(after.status).toBe(transition.to);
          expect(after.version).toBe(1);
        });
      }
    }
  });

  describe('illegal transitions', () => {
    const legal = new Set(ERRAND_TRANSITIONS.map((t) => `${t.from}>${t.to}`));
    for (const from of Object.values(ErrandStatus)) {
      for (const to of Object.values(ErrandStatus)) {
        if (legal.has(`${from}>${to}`)) continue;
        it(`${from} -> ${to} throws ERRAND_INVALID_STATE and changes nothing`, async () => {
          const id = await startFor(from, to);
          await expect(run({ errandId: id, to, actor: { type: 'ADMIN' } })).rejects.toMatchObject({ code: 'ERRAND_INVALID_STATE' });
          const after = await row(id);
          expect(after.status).toBe(from);
          expect(after.version).toBe(0);
        });
      }
    }
  });

  it('refuses an actor the row does not allow with FORBIDDEN, and leaves the errand alone', async () => {
    const id = await make('DRAFT');
    await expect(run({ errandId: id, to: 'OPEN', actor: { type: 'RUNNER', id: requesterId } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await row(id)).status).toBe('DRAFT');
  });

  it('answers "not found" when the errand belongs to someone else', async () => {
    const id = await make('OPEN');
    const other = await signedInUser(app);
    await expect(run({ errandId: id, to: 'CANCELLED', actor: { type: 'REQUESTER', id: other.userId }, ownerId: other.userId, cancellation: { reason: 'REQUESTER_CANCELLED' } })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('rejects a stale version', async () => {
    const id = await make('OPEN');
    await run({ errandId: id, to: 'RUNNER_SELECTED', actor: { type: 'REQUESTER', id: requesterId } });
    await expect(
      run({ errandId: id, to: 'CANCELLED', actor: { type: 'REQUESTER', id: requesterId }, expectedVersion: 0, cancellation: { reason: 'REQUESTER_CANCELLED' } }),
    ).rejects.toMatchObject({ code: 'ERRAND_INVALID_STATE', details: { reason: 'VERSION_MISMATCH' } });
  });

  it('rejects an action whose precondition status does not hold', async () => {
    const id = await make('OPEN');
    await expect(run({ errandId: id, to: 'OPEN', actor: { type: 'REQUESTER' }, expectedFrom: 'DRAFT' })).rejects.toMatchObject({ code: 'ERRAND_INVALID_STATE' });
  });

  it('needs a cancellation reason', async () => {
    const id = await make('OPEN');
    await expect(run({ errandId: id, to: 'CANCELLED', actor: { type: 'REQUESTER', id: requesterId } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('records who, when and why on a cancellation', async () => {
    const id = await make('OPEN');
    await run({ errandId: id, to: 'CANCELLED', actor: { type: 'REQUESTER', id: requesterId }, cancellation: { reason: 'DUPLICATE_ERRAND', note: 'posted twice' } });
    const after = await row(id);
    expect(after).toMatchObject({ status: 'CANCELLED', reason: 'DUPLICATE_ERRAND', by_type: 'USER' });
    expect(after.cancelled_at).toBeInstanceOf(Date);
  });

  describe('history, audit and outbox', () => {
    it('writes one history row, one audit row and one outbox event in the same transaction', async () => {
      const id = await make('OPEN');
      await run({ errandId: id, to: 'RUNNER_SELECTED', actor: { type: 'REQUESTER', id: requesterId }, reason: 'picked the nearest' });

      const history = await prisma.$queryRaw<Array<Record<string, unknown>>>`SELECT from_status::text AS f, to_status::text AS t, actor_type::text AS a, reason, version FROM errand_status_history WHERE errand_id = ${id}::uuid`;
      expect(history).toEqual([{ f: 'OPEN', t: 'RUNNER_SELECTED', a: 'USER', reason: 'picked the nearest', version: 1 }]);
      const audit = await prisma.$queryRaw<Array<{ action: string }>>`SELECT action FROM audit_logs WHERE entity_id = ${id}::uuid`;
      expect(audit.map((a) => a.action)).toEqual(['errand.status_changed']);
      const events = await prisma.$queryRaw<Array<{ event_type: string; payload: Record<string, unknown> }>>`SELECT event_type, payload FROM outbox_events WHERE aggregate_id = ${id}::uuid`;
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('errand.status_changed');
      expect(events[0].payload).toMatchObject({ errandId: id, from: 'OPEN', to: 'RUNNER_SELECTED', version: 1 });
    });

    it('writes nothing when the transaction fails after the transition', async () => {
      const id = await make('OPEN');
      await expect(
        prisma.$transaction(async (tx) => {
          await service().transition(tx, { errandId: id, to: 'RUNNER_SELECTED', actor: { type: 'REQUESTER', id: requesterId } });
          throw new Error('later step failed');
        }),
      ).rejects.toThrow('later step failed');
      expect((await row(id)).status).toBe('OPEN');
      expect(await prisma.$queryRaw`SELECT 1 FROM errand_status_history WHERE errand_id = ${id}::uuid`).toHaveLength(0);
      expect(await prisma.$queryRaw`SELECT 1 FROM outbox_events WHERE aggregate_id = ${id}::uuid`).toHaveLength(0);
    });

    it('uses the registered event names', async () => {
      const id = await make('OPEN');
      await run({ errandId: id, to: 'CANCELLED', actor: { type: 'REQUESTER', id: requesterId }, cancellation: { reason: 'REQUESTER_CANCELLED' } });
      const events = await prisma.$queryRaw<Array<{ event_type: string }>>`SELECT event_type FROM outbox_events WHERE aggregate_id = ${id}::uuid`;
      expect(events.map((e) => e.event_type)).toEqual(['errand.cancelled']);
    });
  });

  describe('deadlines when an errand reopens (Backend PRD 11.4)', () => {
    it('keeps the original deadline when a runner declines', async () => {
      const id = await make('RUNNER_SELECTED', { expiresInHours: 5 });
      const before = (await row(id)).expires_at as Date;
      const result = await run({ errandId: id, to: 'OPEN', actor: { type: 'RUNNER', id: requesterId } });
      expect(result.to).toBe('OPEN');
      expect(((await row(id)).expires_at as Date).getTime()).toBe(before.getTime());
    });

    it('ends as EXPIRED when the runner declines after the deadline', async () => {
      const id = await make('RUNNER_SELECTED', { expiresInHours: -1 });
      const result = await run({ errandId: id, to: 'OPEN', actor: { type: 'SYSTEM' } });
      expect(result.to).toBe('EXPIRED');
      expect((await row(id)).status).toBe('EXPIRED');
    });

    it('counts a fresh deadline from now when a runner cancels after accepting', async () => {
      const id = await make('ACCEPTED', { expiresInHours: 1 });
      const start = Date.now();
      await run({ errandId: id, to: 'OPEN', actor: { type: 'RUNNER', id: requesterId } });
      const expiresAt = ((await row(id)).expires_at as Date).getTime();
      expect(expiresAt).toBeGreaterThan(start + 23 * 3_600_000);
      expect(expiresAt).toBeLessThan(Date.now() + 25 * 3_600_000);
    });

    it('expires a scheduled errand that reopens too close to its start', async () => {
      const id = await make('ACCEPTED', { timeMode: 'SCHEDULED', scheduledAt: new Date(Date.now() + 10 * 60_000), expiresInHours: 1 });
      const result = await run({ errandId: id, to: 'OPEN', actor: { type: 'RUNNER', id: requesterId } });
      expect(result.to).toBe('EXPIRED');
    });
  });

  describe('delivery, completion and disputes', () => {
    it('starts the 24 h auto-completion clock at delivery and stops it at completion', async () => {
      const id = await make('PICKED_UP');
      await run({ errandId: id, to: 'DELIVERED', actor: { type: 'RUNNER', id: requesterId } });
      const delivered = await row(id);
      const hours = ((delivered.auto_complete_at as Date).getTime() - (delivered.delivered_at as Date).getTime()) / 3_600_000;
      expect(hours).toBeCloseTo(24, 2);

      await run({ errandId: id, to: 'COMPLETED', actor: { type: 'REQUESTER', id: requesterId } });
      const done = await row(id);
      expect(done.auto_complete_at).toBeNull();
      expect(done.completed_at).toBeInstanceOf(Date);
    });

    it('remembers the status before a dispute, clears the clock, and restores both when dismissed', async () => {
      const id = await make('PICKED_UP');
      await run({ errandId: id, to: 'DELIVERED', actor: { type: 'RUNNER', id: requesterId } });
      await run({ errandId: id, to: 'DISPUTED', actor: { type: 'REQUESTER', id: requesterId } });
      const disputed = await row(id);
      expect(disputed).toMatchObject({ status: 'DISPUTED', before: 'DELIVERED', auto_complete_at: null });

      await run({ errandId: id, to: 'DELIVERED', actor: { type: 'ADMIN' } });
      const restored = await row(id);
      expect(restored).toMatchObject({ status: 'DELIVERED', before: null });
      expect(restored.auto_complete_at).toBeInstanceOf(Date);
    });

    it('returns a dismissed dispute only to the status it came from', async () => {
      const id = await make('IN_PROGRESS');
      await run({ errandId: id, to: 'DISPUTED', actor: { type: 'ADMIN' } });
      await expect(run({ errandId: id, to: 'DELIVERED', actor: { type: 'ADMIN' } })).rejects.toMatchObject({ code: 'ERRAND_INVALID_STATE' });
      await run({ errandId: id, to: 'IN_PROGRESS', actor: { type: 'ADMIN' } });
      expect((await row(id)).status).toBe('IN_PROGRESS');
    });
  });

  it('lets exactly one of two simultaneous transitions win', async () => {
    const id = await make('OPEN');
    const results = await Promise.allSettled([
      run({ errandId: id, to: 'RUNNER_SELECTED', actor: { type: 'REQUESTER', id: requesterId } }),
      run({ errandId: id, to: 'RUNNER_SELECTED', actor: { type: 'REQUESTER', id: requesterId } }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'ERRAND_INVALID_STATE' });
    expect((await row(id)).version).toBe(1);
  });

  it('runs the action hook inside the same transaction, after the checks', async () => {
    const id = await make('DRAFT');
    await expect(
      run({
        errandId: id,
        to: 'OPEN',
        actor: { type: 'REQUESTER', id: requesterId },
        apply: async (tx) => {
          await tx.$executeRaw`UPDATE errands SET title = 'changed in hook' WHERE id = ${id}::uuid`;
          throw new Error('hook failed');
        },
      }),
    ).rejects.toThrow('hook failed');
    const title = await prisma.$queryRaw<Array<{ title: string }>>`SELECT title FROM errands WHERE id = ${id}::uuid`;
    expect(title[0].title).toBe('Collect a parcel');
  });

  it('never allows a DB row to break the status rules', async () => {
    const id = await make('OPEN');
    await expect(prisma.$executeRaw`UPDATE errands SET status = 'CANCELLED' WHERE id = ${id}::uuid`).rejects.toThrow(/errands_cancelled_fields/);
    await expect(prisma.$executeRaw`UPDATE errands SET status = 'DISPUTED' WHERE id = ${id}::uuid`).rejects.toThrow(/errands_disputed_fields/);
    await expect(prisma.$executeRaw`UPDATE errands SET feed_point = NULL WHERE id = ${id}::uuid`).rejects.toThrow(/errands_open_has_feed_point/);
  });
});

// Keeps the actor type in scope for readers: the table lists who may do what.
export type { ErrandActor };

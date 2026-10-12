import { ErrandStatus } from '@prisma/client';
import {
  ERRAND_TRANSITIONS,
  TERMINAL_STATUSES,
  eventFor,
  findTransition,
  isLegalTransition,
  mayActorTransition,
  nextStatuses,
  type ErrandActor,
} from './errand.state.js';

const ALL = Object.values(ErrandStatus);
const ACTORS: ErrandActor[] = ['REQUESTER', 'RUNNER', 'ADMIN', 'SYSTEM'];

/** Backend PRD 11.6, written out again by hand so a mistake in the table shows up here. */
const EXPECTED: Array<[ErrandStatus, ErrandStatus, ErrandActor[]]> = [
  ['DRAFT', 'OPEN', ['REQUESTER']],
  ['DRAFT', 'CANCELLED', ['REQUESTER']],
  ['OPEN', 'RUNNER_SELECTED', ['REQUESTER']],
  ['OPEN', 'CANCELLED', ['REQUESTER', 'ADMIN']],
  ['OPEN', 'EXPIRED', ['SYSTEM', 'ADMIN']],
  ['RUNNER_SELECTED', 'ACCEPTED', ['RUNNER']],
  ['RUNNER_SELECTED', 'OPEN', ['RUNNER', 'SYSTEM']],
  ['RUNNER_SELECTED', 'EXPIRED', ['RUNNER', 'SYSTEM']],
  ['RUNNER_SELECTED', 'CANCELLED', ['REQUESTER', 'ADMIN']],
  ['ACCEPTED', 'IN_PROGRESS', ['RUNNER']],
  ['ACCEPTED', 'OPEN', ['RUNNER', 'ADMIN']],
  ['ACCEPTED', 'CANCELLED', ['REQUESTER', 'ADMIN']],
  ['IN_PROGRESS', 'PICKED_UP', ['RUNNER']],
  ['IN_PROGRESS', 'CANCELLED', ['REQUESTER', 'RUNNER', 'ADMIN']],
  ['PICKED_UP', 'DELIVERED', ['RUNNER']],
  ['DELIVERED', 'COMPLETED', ['REQUESTER', 'SYSTEM']],
  ['ACCEPTED', 'DISPUTED', ['REQUESTER', 'RUNNER', 'ADMIN', 'SYSTEM']],
  ['IN_PROGRESS', 'DISPUTED', ['REQUESTER', 'RUNNER', 'ADMIN', 'SYSTEM']],
  ['PICKED_UP', 'DISPUTED', ['REQUESTER', 'RUNNER', 'ADMIN', 'SYSTEM']],
  ['DELIVERED', 'DISPUTED', ['REQUESTER', 'RUNNER', 'ADMIN', 'SYSTEM']],
  ['DISPUTED', 'COMPLETED', ['ADMIN', 'SYSTEM']],
  ['DISPUTED', 'CANCELLED', ['ADMIN', 'SYSTEM']],
  ['DISPUTED', 'ACCEPTED', ['ADMIN', 'SYSTEM']],
  ['DISPUTED', 'IN_PROGRESS', ['ADMIN', 'SYSTEM']],
  ['DISPUTED', 'PICKED_UP', ['ADMIN', 'SYSTEM']],
  ['DISPUTED', 'DELIVERED', ['ADMIN', 'SYSTEM']],
  // Backend PRD 24.4: an admin reopens an errand that ended without the work being done.
  ['EXPIRED', 'OPEN', ['ADMIN']],
  ['CANCELLED', 'OPEN', ['ADMIN']],
];

describe('errand state machine table', () => {
  it('has exactly the rows of Backend PRD 11.6', () => {
    expect(ERRAND_TRANSITIONS).toHaveLength(EXPECTED.length);
    for (const [from, to, actors] of EXPECTED) {
      const row = findTransition(from, to);
      expect(row, `${from} -> ${to}`).toBeDefined();
      expect([...row!.actors].sort()).toEqual([...actors].sort());
    }
  });

  it.each(EXPECTED)('%s -> %s: only the listed actors may do it', (from, to, actors) => {
    for (const actor of ACTORS) {
      expect(mayActorTransition(from, to, actor), `${actor}`).toBe(actors.includes(actor));
    }
  });

  it('refuses every pair that is not in the table (including staying in place)', () => {
    const legal = new Set(EXPECTED.map(([from, to]) => `${from}>${to}`));
    for (const from of ALL) {
      for (const to of ALL) {
        expect(isLegalTransition(from, to), `${from} -> ${to}`).toBe(legal.has(`${from}>${to}`));
      }
    }
  });

  it('lets no ordinary action leave a terminal status', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(nextStatuses(status, 'REQUESTER')).toEqual([]);
      expect(nextStatuses(status, 'RUNNER')).toEqual([]);
    }
  });

  it('gives reopening transitions a rule for the deadline', () => {
    expect(findTransition('RUNNER_SELECTED', 'OPEN')?.expiry).toBe('KEEP');
    expect(findTransition('ACCEPTED', 'OPEN')?.expiry).toBe('RECOMPUTE');
  });

  it('asks for a reason on every cancellation', () => {
    for (const row of ERRAND_TRANSITIONS.filter((r) => r.to === 'CANCELLED')) {
      expect(row.needsCancellation, `${row.from} -> CANCELLED`).toBe(true);
    }
  });

  it('only a runner moves execution forward, and a requester never starts, picks up or delivers', () => {
    for (const [from, to] of [
      ['ACCEPTED', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'PICKED_UP'],
      ['PICKED_UP', 'DELIVERED'],
    ] as const) {
      expect(mayActorTransition(from, to, 'REQUESTER')).toBe(false);
      expect(mayActorTransition(from, to, 'RUNNER')).toBe(true);
    }
  });

  it('never lets a picked-up errand be cancelled directly (it becomes a dispute)', () => {
    expect(isLegalTransition('PICKED_UP', 'CANCELLED')).toBe(false);
    expect(isLegalTransition('DELIVERED', 'CANCELLED')).toBe(false);
  });
});

describe('eventFor', () => {
  it('names the events the queue registry knows', () => {
    expect(eventFor('DRAFT', 'OPEN')).toBe('errand.published');
    expect(eventFor('OPEN', 'CANCELLED')).toBe('errand.cancelled');
    expect(eventFor('OPEN', 'EXPIRED')).toBe('errand.expired');
    expect(eventFor('DELIVERED', 'COMPLETED')).toBe('errand.completed');
    expect(eventFor('ACCEPTED', 'DISPUTED')).toBe('errand.disputed');
    expect(eventFor('ACCEPTED', 'IN_PROGRESS')).toBe('errand.status_changed');
  });
});

import type { ErrandStatus } from '@prisma/client';

/**
 * The errand state machine (Backend PRD 11.6), as data. `ErrandStateService` is the only code
 * that changes `errands.status`, and it only follows rows of this table. A client never sends a
 * status: it asks for an action, and the action asks for a transition.
 */

export type ErrandActor = 'REQUESTER' | 'RUNNER' | 'ADMIN' | 'SYSTEM';

export interface ErrandTransition {
  from: ErrandStatus;
  to: ErrandStatus;
  /** Who may cause it. */
  actors: readonly ErrandActor[];
  /** What the PRD calls the trigger, for logs and tests. */
  trigger: string;
  /** Reopening: keep the original deadline, or compute a new one from now (Backend PRD 11.4). */
  expiry?: 'KEEP' | 'RECOMPUTE';
  /** The cancel reason must be given. */
  needsCancellation?: true;
}

const IN_FLIGHT: readonly ErrandStatus[] = ['ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED'];

export const ERRAND_TRANSITIONS: readonly ErrandTransition[] = [
  { from: 'DRAFT', to: 'OPEN', actors: ['REQUESTER'], trigger: 'Requester publishes' },
  { from: 'DRAFT', to: 'CANCELLED', actors: ['REQUESTER'], trigger: 'Requester cancels the draft', needsCancellation: true },
  { from: 'OPEN', to: 'RUNNER_SELECTED', actors: ['REQUESTER'], trigger: 'Requester selects a runner' },
  { from: 'OPEN', to: 'CANCELLED', actors: ['REQUESTER', 'ADMIN'], trigger: 'Requester cancels', needsCancellation: true },
  { from: 'OPEN', to: 'EXPIRED', actors: ['SYSTEM'], trigger: 'No runner selected before expiresAt' },
  { from: 'RUNNER_SELECTED', to: 'ACCEPTED', actors: ['RUNNER'], trigger: 'Selected runner accepts in time' },
  { from: 'RUNNER_SELECTED', to: 'OPEN', actors: ['RUNNER', 'SYSTEM'], trigger: 'Runner declines or the acceptance window ends', expiry: 'KEEP' },
  // Backend PRD 11.4: a decline or timeout after the deadline has passed ends the errand instead.
  { from: 'RUNNER_SELECTED', to: 'EXPIRED', actors: ['RUNNER', 'SYSTEM'], trigger: 'Declined or timed out after expiresAt' },
  { from: 'RUNNER_SELECTED', to: 'CANCELLED', actors: ['REQUESTER', 'ADMIN'], trigger: 'Requester cancels', needsCancellation: true },
  { from: 'ACCEPTED', to: 'IN_PROGRESS', actors: ['RUNNER'], trigger: 'Runner starts' },
  { from: 'ACCEPTED', to: 'OPEN', actors: ['RUNNER', 'ADMIN'], trigger: 'Runner cancels before IN_PROGRESS', expiry: 'RECOMPUTE' },
  { from: 'ACCEPTED', to: 'CANCELLED', actors: ['REQUESTER', 'ADMIN'], trigger: 'Requester or admin cancels', needsCancellation: true },
  { from: 'IN_PROGRESS', to: 'PICKED_UP', actors: ['RUNNER'], trigger: 'Runner confirms pickup' },
  { from: 'IN_PROGRESS', to: 'CANCELLED', actors: ['REQUESTER', 'RUNNER', 'ADMIN'], trigger: 'Either party cancels', needsCancellation: true },
  { from: 'PICKED_UP', to: 'DELIVERED', actors: ['RUNNER'], trigger: 'Runner confirms delivery' },
  { from: 'DELIVERED', to: 'COMPLETED', actors: ['REQUESTER', 'SYSTEM'], trigger: 'Requester confirms, or auto-completion' },
  ...IN_FLIGHT.map(
    (from): ErrandTransition => ({ from, to: 'DISPUTED', actors: ['REQUESTER', 'RUNNER', 'ADMIN', 'SYSTEM'], trigger: 'A dispute is opened' }),
  ),
  { from: 'DISPUTED', to: 'COMPLETED', actors: ['ADMIN', 'SYSTEM'], trigger: 'Dispute resolved as COMPLETE' },
  { from: 'DISPUTED', to: 'CANCELLED', actors: ['ADMIN', 'SYSTEM'], trigger: 'Dispute resolved as CANCEL', needsCancellation: true },
  // Dismissed dispute: back to the state before it. Only the status stored in statusBeforeDispute is allowed.
  ...IN_FLIGHT.map(
    (to): ErrandTransition => ({ from: 'DISPUTED', to, actors: ['ADMIN', 'SYSTEM'], trigger: 'Dispute resolved as DISMISS' }),
  ),
];

/** Terminal for ordinary user actions. */
export const TERMINAL_STATUSES: readonly ErrandStatus[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];

export function findTransition(from: ErrandStatus, to: ErrandStatus): ErrandTransition | undefined {
  return ERRAND_TRANSITIONS.find((row) => row.from === from && row.to === to);
}

export function isLegalTransition(from: ErrandStatus, to: ErrandStatus): boolean {
  return findTransition(from, to) !== undefined;
}

export function mayActorTransition(from: ErrandStatus, to: ErrandStatus, actor: ErrandActor): boolean {
  return findTransition(from, to)?.actors.includes(actor) ?? false;
}

/** The statuses an actor could move an errand to next (the dispute return target depends on the row). */
export function nextStatuses(from: ErrandStatus, actor: ErrandActor): ErrandStatus[] {
  return ERRAND_TRANSITIONS.filter((row) => row.from === from && row.actors.includes(actor)).map((row) => row.to);
}

/** The outbox event a transition raises (Backend PRD 25.1). Other changes use `errand.status_changed`. */
export function eventFor(from: ErrandStatus, to: ErrandStatus): string {
  if (from === 'DRAFT' && to === 'OPEN') return 'errand.published';
  if (to === 'CANCELLED') return 'errand.cancelled';
  if (to === 'EXPIRED') return 'errand.expired';
  if (to === 'COMPLETED') return 'errand.completed';
  if (to === 'DISPUTED') return 'errand.disputed';
  return 'errand.status_changed';
}

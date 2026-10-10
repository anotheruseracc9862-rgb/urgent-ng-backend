import { Injectable } from '@nestjs/common';
import type { ErrandCancellationReason, ErrandStatus, Prisma } from '@prisma/client';
import type { ErrandActor } from './errand.state.js';

/** What happened to the errand, for whoever keeps the assignment in step with it. */
export interface ErrandTransitionContext {
  errandId: string;
  from: ErrandStatus;
  /** The status the errand ended in (a reopening can end as EXPIRED). */
  to: ErrandStatus;
  actor: { type: ErrandActor; id?: string };
  cancellation?: { reason: ErrandCancellationReason; note?: string };
  reason?: string;
}

export interface AssignmentTransitionHandler {
  /** Runs inside the errand transition's transaction, after the status was written. */
  onErrandTransition(tx: Prisma.TransactionClient, context: ErrandTransitionContext): Promise<void>;
}

/**
 * The errand module cannot import the assignment module (a cycle), so the assignment module
 * registers its handler here when it starts. Every errand transition calls it, so an assignment
 * can never contradict its errand, whoever moved the errand (requester, runner, admin, system).
 * Transitions the assignment module performs itself pass `assignmentHandled` and skip it.
 */
@Injectable()
export class AssignmentTransitionRegistry {
  private handler?: AssignmentTransitionHandler;

  register(handler: AssignmentTransitionHandler): void {
    this.handler = handler;
  }

  async run(tx: Prisma.TransactionClient, context: ErrandTransitionContext): Promise<void> {
    await this.handler?.onErrandTransition(tx, context);
  }
}

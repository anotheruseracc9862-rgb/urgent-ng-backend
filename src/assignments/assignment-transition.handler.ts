import { Injectable, OnModuleInit } from '@nestjs/common';
import { AuditActorType, type Prisma } from '@prisma/client';
import { AssignmentTransitionRegistry, type AssignmentTransitionHandler, type ErrandTransitionContext } from '../errands/assignment-transition.registry.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { OfferService } from '../offers/offer.service.js';

const auditActor = (type: ErrandTransitionContext['actor']['type']): AuditActorType =>
  type === 'ADMIN' ? AuditActorType.ADMIN : type === 'SYSTEM' ? AuditActorType.SYSTEM : AuditActorType.USER;

interface LiveAssignment {
  id: string;
  status: 'PENDING_ACCEPTANCE' | 'ACCEPTED';
  selected_offer_id: string;
  runner_id: string;
  requester_id: string;
  version: number;
}

/**
 * Keeps the assignment in step with its errand whoever moves the errand (Backend PRD 11.6, 14).
 * The errand status is the execution status; the assignment only changes at the ends:
 *
 *   -> CANCELLED       the live assignment is cancelled (a pending one also closes its offer)
 *   -> COMPLETED       an accepted assignment is completed
 *   ACCEPTED -> OPEN   the runner (or an admin) cancelled: the assignment is cancelled, the errand reopens
 *
 * Decline and timeout belong to `AssignmentService` and skip this handler.
 */
@Injectable()
export class AssignmentTransitionHandlerImpl implements AssignmentTransitionHandler, OnModuleInit {
  constructor(
    private readonly registry: AssignmentTransitionRegistry,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly offers: OfferService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async onErrandTransition(tx: Prisma.TransactionClient, context: ErrandTransitionContext): Promise<void> {
    const cancelling = context.to === 'CANCELLED' || (context.from === 'ACCEPTED' && context.to === 'OPEN');
    const completing = context.to === 'COMPLETED';
    if (!cancelling && !completing) {
      return;
    }

    const rows = await tx.$queryRaw<LiveAssignment[]>`
      SELECT id::text, status::text AS status, selected_offer_id::text, runner_id::text, requester_id::text, version
      FROM assignments
      WHERE errand_id = ${context.errandId}::uuid AND deleted_at IS NULL
        AND status IN ('PENDING_ACCEPTANCE'::"AssignmentStatus", 'ACCEPTED'::"AssignmentStatus")
      FOR UPDATE
    `;
    const assignment = rows[0];
    if (!assignment) {
      return;
    }

    if (completing) {
      if (assignment.status !== 'ACCEPTED') return;
      await tx.$executeRaw`
        UPDATE assignments
        SET status = 'COMPLETED'::"AssignmentStatus", completed_at = clock_timestamp(),
            version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${assignment.id}::uuid
      `;
      await this.record(tx, 'assignment.completed', assignment, context, {});
      return;
    }

    const reason = context.cancellation?.reason ?? this.defaultReason(context);
    const stage = context.from;
    await tx.$executeRaw`
      UPDATE assignments
      SET status = 'CANCELLED'::"AssignmentStatus", cancelled_at = clock_timestamp(),
          cancelled_by = ${context.actor.id ?? null}::uuid,
          cancelled_by_type = ${auditActor(context.actor.type)}::"AuditActorType",
          cancellation_reason = ${reason}::"ErrandCancellationReason",
          cancellation_note = ${context.cancellation?.note ?? null},
          cancelled_stage = ${stage}::"ErrandStatus",
          version = version + 1, updated_at = clock_timestamp()
      WHERE id = ${assignment.id}::uuid
    `;
    if (assignment.status === 'PENDING_ACCEPTANCE') {
      await this.offers.closeSelected(tx, assignment.selected_offer_id, 'ERRAND_CANCELLED');
    }
    await this.record(tx, 'assignment.cancelled', assignment, context, { reason, stage, previousStatus: assignment.status });
  }

  private defaultReason(context: ErrandTransitionContext): 'RUNNER_CANCELLED' | 'ADMIN_CANCELLED' | 'REQUESTER_CANCELLED' | 'OTHER' {
    if (context.actor.type === 'RUNNER') return 'RUNNER_CANCELLED';
    if (context.actor.type === 'ADMIN') return 'ADMIN_CANCELLED';
    if (context.actor.type === 'REQUESTER') return 'REQUESTER_CANCELLED';
    return 'OTHER';
  }

  private async record(
    tx: Prisma.TransactionClient,
    eventType: string,
    assignment: LiveAssignment,
    context: ErrandTransitionContext,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.outbox.add(tx, {
      eventType,
      aggregateType: 'assignment',
      aggregateId: assignment.id,
      payload: {
        assignmentId: assignment.id,
        errandId: context.errandId,
        requesterId: assignment.requester_id,
        runnerId: assignment.runner_id,
        offerId: assignment.selected_offer_id,
        actorType: context.actor.type,
        actorId: context.actor.id ?? null,
        stage: context.from,
        ...extra,
      },
    });
    await this.audit.recordInTransaction(tx, {
      actorType: auditActor(context.actor.type),
      actorId: context.actor.id,
      action: eventType,
      entityType: 'assignment',
      entityId: assignment.id,
      metadata: { errandId: context.errandId, from: context.from, to: context.to, ...extra },
    });
  }
}

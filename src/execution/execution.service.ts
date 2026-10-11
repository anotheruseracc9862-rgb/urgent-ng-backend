import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType, type ErrandStatus, type ExecutionEventType, type MediaPurpose, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { MediaService } from '../media/media.service.js';
import { ChangeRequestService } from '../assignments/change-request.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ASSIGNMENT_INVALID_STATE, MEDIA_INVALID, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { ErrandStateService, type LockedErrand } from '../errands/errand-state.service.js';
import type { ExecutionStepDto, StepEvidenceDto } from './execution.dto.js';

/** Raised inside the auto-completion transaction when nothing is due after all: roll back quietly. */
class NotDue extends Error {}

type Step = {
  name: 'start' | 'pickup' | 'deliver';
  from: ErrandStatus;
  to: ErrandStatus;
  event: ExecutionEventType;
  outbox: 'execution.started' | 'execution.picked_up' | 'execution.delivered';
  evidencePurpose?: MediaPurpose;
  checkpoint?: 'PICKUP' | 'DELIVERY';
};

const STEPS: Record<'start' | 'pickup' | 'deliver', Step> = {
  start: { name: 'start', from: 'ACCEPTED', to: 'IN_PROGRESS', event: 'STARTED', outbox: 'execution.started' },
  pickup: {
    name: 'pickup',
    from: 'IN_PROGRESS',
    to: 'PICKED_UP',
    event: 'PICKED_UP',
    outbox: 'execution.picked_up',
    evidencePurpose: 'PICKUP_EVIDENCE',
    checkpoint: 'PICKUP',
  },
  deliver: {
    name: 'deliver',
    from: 'PICKED_UP',
    to: 'DELIVERED',
    event: 'DELIVERED',
    outbox: 'execution.delivered',
    evidencePurpose: 'DELIVERY_EVIDENCE',
    checkpoint: 'DELIVERY',
  },
};

const FUTURE_TOLERANCE_MS = 5 * 60_000;

/**
 * Execution (Backend PRD 15): start, pickup, delivery, completion and auto-completion. The errand
 * status is the execution status; each step is one errand transition plus an append-only
 * `execution_events` row, an audit row and an outbox event, in one transaction. A step is allowed
 * only to the runner of an `ACCEPTED` assignment.
 */
@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly errandState: ErrandStateService,
    private readonly media: MediaService,
    private readonly changeRequests: ChangeRequestService,
  ) {}

  start(runnerId: string, assignmentId: string): Promise<ExecutionStepDto> {
    return this.step(runnerId, assignmentId, STEPS.start, {});
  }

  pickup(runnerId: string, assignmentId: string, evidence: StepEvidenceDto): Promise<ExecutionStepDto> {
    return this.step(runnerId, assignmentId, STEPS.pickup, evidence);
  }

  deliver(runnerId: string, assignmentId: string, evidence: StepEvidenceDto): Promise<ExecutionStepDto> {
    return this.step(runnerId, assignmentId, STEPS.deliver, evidence);
  }

  /** The requester confirms completion after delivery (Backend PRD 15.2). */
  async complete(requesterId: string, errandId: string): Promise<ExecutionStepDto> {
    let out: ExecutionStepDto | undefined;
    await this.prisma.$transaction(async (tx) => {
      const result = await this.errandState.transition(tx, {
        errandId,
        to: 'COMPLETED',
        ownerId: requesterId,
        expectedFrom: 'DELIVERED',
        actor: { type: 'REQUESTER', id: requesterId },
        reason: 'Requester confirmed completion.',
        apply: async (inner) => {
          const assignment = await this.liveAssignmentOf(inner, errandId);
          out = await this.record(inner, assignment, 'COMPLETED', { type: 'USER', id: requesterId }, {}, null);
        },
      });
      if (out) out.errandStatus = result.to;
    });
    return out as ExecutionStepDto;
  }

  /**
   * Complete delivered errands whose 24 hours passed without a response (Backend PRD 15.2). The
   * deadline is `errands.auto_complete_at`. A dispute or an open report clears it, so a paused
   * errand is never selected; the row is re-read under its lock regardless.
   */
  async autoCompleteDue(limit = 100): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM errands
      WHERE status = 'DELIVERED'::"ErrandStatus" AND deleted_at IS NULL
        AND auto_complete_at IS NOT NULL AND auto_complete_at <= clock_timestamp()
        AND NOT EXISTS (
          SELECT 1 FROM reports r
          WHERE r.errand_id = errands.id AND r.pauses_auto_completion AND r.deleted_at IS NULL
            AND r.status IN ('OPEN'::"ReportStatus", 'UNDER_REVIEW'::"ReportStatus", 'ACTION_REQUIRED'::"ReportStatus")
        )
      ORDER BY auto_complete_at
      LIMIT ${limit}
    `;
    let completed = 0;
    for (const { id } of due) {
      try {
        if (await this.autoCompleteOne(id)) completed += 1;
      } catch (error) {
        this.logger.error(`Could not auto-complete errand ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return completed;
  }

  private async autoCompleteOne(errandId: string): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.errandState.transition(tx, {
          errandId,
          to: 'COMPLETED',
          expectedFrom: 'DELIVERED',
          actor: { type: 'SYSTEM' },
          reason: 'Auto-completed: the requester did not respond within the window.',
          apply: async (inner, errand) => {
            // Re-check under the lock: a dispute or report may have paused it after the scan.
            if (!errand.auto_complete_at || errand.auto_complete_at > errand.db_now) {
              throw new NotDue();
            }
            const assignment = await this.liveAssignmentOf(inner, errandId);
            await this.record(inner, assignment, 'AUTO_COMPLETED', { type: 'SYSTEM' }, {}, null);
          },
        });
      });
      return true;
    } catch (error) {
      if (error instanceof NotDue) return false;
      // The errand moved on (disputed, completed by the requester): nothing to do.
      if (error instanceof DomainException && error.getCode() === 'ERRAND_INVALID_STATE') return false;
      throw error;
    }
  }

  // ---- internals ----

  private async step(runnerId: string, assignmentId: string, step: Step, evidence: StepEvidenceDto): Promise<ExecutionStepDto> {
    const found = await this.prisma.assignment.findFirst({ where: { id: assignmentId, runnerId }, select: { errandId: true } });
    if (!found) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    // Pool reads happen before the transaction.
    if (evidence.mediaId && step.evidencePurpose) {
      await this.media.requireReadyOwned(runnerId, evidence.mediaId, step.evidencePurpose);
    } else if (evidence.mediaId) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'This step takes no photo.', details: { field: 'mediaId' } });
    }
    if ((evidence.note || evidence.checkpoint) && !step.evidencePurpose) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'This step takes no note or checkpoint.' });
    }

    let out: ExecutionStepDto | undefined;
    await this.prisma.$transaction(async (tx) => {
      const result = await this.errandState.transition(tx, {
        errandId: found.errandId,
        to: step.to,
        expectedFrom: step.from,
        actor: { type: 'RUNNER', id: runnerId },
        reason: `Runner: ${step.name}.`,
        apply: async (inner, errand) => {
          const assignment = await this.lockAccepted(inner, assignmentId, runnerId);
          await this.assertMediaUnused(inner, evidence.mediaId);
          if (step.name === 'pickup') {
            // Pickup closes the window for change requests (Backend PRD 15.6).
            await this.changeRequests.expirePendingAtPickup(inner, assignment.id);
          }
          if (evidence.checkpoint && step.checkpoint) {
            await this.writeCheckpoint(inner, assignment.id, step.checkpoint, evidence, errand);
          }
          out = await this.record(
            inner,
            assignment,
            step.event,
            { type: 'USER', id: runnerId },
            { note: evidence.note },
            evidence.mediaId ?? null,
            step.outbox,
          );
        },
      });
      if (out) {
        out.errandStatus = result.to;
        if (step.to === 'DELIVERED') {
          const row = await tx.errand.findUniqueOrThrow({ where: { id: found.errandId }, select: { autoCompleteAt: true } });
          out.autoCompleteAt = row.autoCompleteAt;
        }
      }
    });
    return out as ExecutionStepDto;
  }

  /** Lock the assignment (the errand is already locked): it must be the caller's and `ACCEPTED`. */
  private async lockAccepted(tx: Prisma.TransactionClient, assignmentId: string, runnerId: string) {
    const rows = await tx.$queryRaw<AssignmentRow[]>`
      SELECT id::text, errand_id::text, requester_id::text, runner_id::text, status::text AS status
      FROM assignments WHERE id = ${assignmentId}::uuid AND deleted_at IS NULL FOR UPDATE
    `;
    const row = rows[0];
    if (!row || row.runner_id !== runnerId) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (row.status !== 'ACCEPTED') {
      throw DomainException.of(ASSIGNMENT_INVALID_STATE, { details: { status: row.status } });
    }
    return row;
  }

  private async liveAssignmentOf(tx: Prisma.TransactionClient, errandId: string): Promise<AssignmentRow> {
    const rows = await tx.$queryRaw<AssignmentRow[]>`
      SELECT id::text, errand_id::text, requester_id::text, runner_id::text, status::text AS status
      FROM assignments
      WHERE errand_id = ${errandId}::uuid AND status = 'ACCEPTED'::"AssignmentStatus" AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (!rows[0]) {
      throw DomainException.of(ASSIGNMENT_INVALID_STATE, { message: 'This errand has no accepted assignment.' });
    }
    return rows[0];
  }

  /** A photo is evidence of one step. Reusing an upload would let one photo vouch for two events. */
  private async assertMediaUnused(tx: Prisma.TransactionClient, mediaId?: string): Promise<void> {
    if (!mediaId) return;
    const used = await tx.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM execution_events WHERE media_id = ${mediaId}::uuid
      UNION ALL SELECT 1 FROM checkpoints WHERE media_id = ${mediaId}::uuid
      UNION ALL SELECT 1 FROM execution_problems WHERE media_id = ${mediaId}::uuid
      LIMIT 1
    `;
    if (used.length > 0) {
      throw DomainException.of(MEDIA_INVALID, { message: 'This photo was already used.' });
    }
  }

  private async writeCheckpoint(
    tx: Prisma.TransactionClient,
    assignmentId: string,
    type: 'PICKUP' | 'DELIVERY',
    evidence: StepEvidenceDto,
    errand: LockedErrand,
  ): Promise<void> {
    const checkpoint = evidence.checkpoint!;
    const capturedAt = checkpoint.capturedAt ?? errand.db_now;
    if (capturedAt.getTime() > errand.db_now.getTime() + FUTURE_TOLERANCE_MS) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'The capture time is in the future.', details: { field: 'checkpoint.capturedAt' } });
    }
    await tx.$executeRaw`
      INSERT INTO checkpoints (assignment_id, type, point, captured_at, note, media_id)
      VALUES (${assignmentId}::uuid, ${type}::"CheckpointType",
              ST_SetSRID(ST_MakePoint(${checkpoint.lng}::float8, ${checkpoint.lat}::float8), 4326)::geography,
              ${capturedAt}::timestamptz, ${evidence.note ?? null}, ${evidence.mediaId ?? null}::uuid)
    `;
  }

  private async record(
    tx: Prisma.TransactionClient,
    assignment: AssignmentRow,
    type: ExecutionEventType,
    actor: { type: 'USER' | 'SYSTEM'; id?: string },
    extra: { note?: string },
    mediaId: string | null,
    outboxType?: string,
  ): Promise<ExecutionStepDto> {
    const event = await tx.executionEvent.create({
      data: {
        assignmentId: assignment.id,
        errandId: assignment.errand_id,
        type,
        actorId: actor.id,
        actorType: actor.type === 'SYSTEM' ? AuditActorType.SYSTEM : AuditActorType.USER,
        note: extra.note,
        mediaId,
      },
    });
    if (outboxType) {
      await this.outbox.add(tx, {
        eventType: outboxType,
        aggregateType: 'assignment',
        aggregateId: assignment.id,
        payload: {
          assignmentId: assignment.id,
          errandId: assignment.errand_id,
          requesterId: assignment.requester_id,
          runnerId: assignment.runner_id,
          type,
          hasEvidence: mediaId !== null,
        },
      });
    }
    await this.audit.recordInTransaction(tx, {
      actorType: actor.type === 'SYSTEM' ? AuditActorType.SYSTEM : AuditActorType.USER,
      actorId: actor.id,
      action: `execution.${type.toLowerCase()}`,
      entityType: 'assignment',
      entityId: assignment.id,
      metadata: { errandId: assignment.errand_id },
    });
    return {
      assignmentId: assignment.id,
      errandId: assignment.errand_id,
      errandStatus: '',
      eventId: event.id,
      type,
      at: event.createdAt,
      autoCompleteAt: null,
    };
  }
}

interface AssignmentRow {
  id: string;
  errand_id: string;
  requester_id: string;
  runner_id: string;
  status: string;
}

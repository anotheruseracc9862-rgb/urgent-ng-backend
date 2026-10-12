import { Injectable } from '@nestjs/common';
import { AuditActorType, type ExecutionEventType, type MediaPurpose, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { MediaService } from '../media/media.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ASSIGNMENT_INVALID_STATE, MEDIA_INVALID, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import type { ArrivedDto, DelayNoticeDto, ExecutionEventDto, ProblemDto, ReceiptDto, ReportProblemDto } from './execution-details.dto.js';

/** Errand statuses in which the runner still has work to do. */
const WORKING: readonly string[] = ['ACCEPTED', 'IN_PROGRESS', 'PICKED_UP'];
/** A receipt may be added until the errand is delivered (PRD 15.5). */
const RECEIPT_WINDOW: readonly string[] = ['ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED'];
/** Open problems after which both parties are told a dispute is available (PRD 15.4). */
const SUGGEST_DISPUTE_AT = 2;
const RECEIPT_CATEGORY_KEY = 'shopping_purchase';

interface Locked {
  id: string;
  errandId: string;
  requesterId: string;
  runnerId: string;
  errandStatus: string;
  categoryKey: string;
}

/**
 * Problems, delay notices and purchase receipts (Backend PRD 15.4, 15.5). None of them changes the
 * errand status or the agreed amount: each writes its own record, an execution event, an audit
 * row and an outbox event in one transaction. Lock order is the same as everywhere else: errand
 * (shared, so a concurrent cancel waits), then the assignment row.
 */
@Injectable()
export class ExecutionDetailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly media: MediaService,
  ) {}

  async reportProblem(runnerId: string, assignmentId: string, input: ReportProblemDto): Promise<ProblemDto> {
    await this.requireRunner(runnerId, assignmentId);
    if (input.mediaId) {
      await this.media.requireReadyOwned(runnerId, input.mediaId, 'PICKUP_EVIDENCE');
    }
    return this.prisma.$transaction(async (tx) => {
      const a = await this.lockWorking(tx, assignmentId, runnerId, WORKING);
      await this.assertMediaUnused(tx, input.mediaId);
      const problem = await tx.executionProblem.create({
        data: { assignmentId, reportedBy: runnerId, type: input.type, note: input.note, mediaId: input.mediaId },
      });
      const open = await tx.executionProblem.count({ where: { assignmentId, status: 'OPEN' } });
      await this.record(tx, a, 'PROBLEM_REPORTED', runnerId, {
        note: input.note,
        mediaId: input.mediaId,
        metadata: { problemId: problem.id, type: input.type },
        outbox: 'execution.problem_reported',
        extra: { problemId: problem.id, type: input.type, openProblems: open },
      });
      return this.toProblem(problem, open >= SUGGEST_DISPUTE_AT);
    });
  }

  /**
   * "I arrived at pickup": the runner tells the requester they are at the pickup point. Allowed
   * once, after the errand started and before pickup. The errand status does not change, so the
   * state machine and the cancellation matrix are untouched.
   */
  async arrived(runnerId: string, assignmentId: string, input: ArrivedDto): Promise<ExecutionEventDto> {
    await this.requireRunner(runnerId, assignmentId);
    return this.prisma.$transaction(async (tx) => {
      const a = await this.lockWorking(tx, assignmentId, runnerId, ['IN_PROGRESS']);
      const already = await tx.executionEvent.count({ where: { assignmentId, type: 'ARRIVED' } });
      if (already > 0) {
        throw DomainException.of(ASSIGNMENT_INVALID_STATE, { message: 'You already marked yourself as arrived.' });
      }
      if (input.checkpoint) {
        const c = input.checkpoint;
        const now = await this.dbNow(tx);
        const capturedAt = c.capturedAt ?? now;
        if (capturedAt.getTime() > now.getTime() + 5 * 60_000) {
          throw DomainException.of(VALIDATION_ERROR, { message: 'The capture time is in the future.', details: { field: 'checkpoint.capturedAt' } });
        }
        await tx.$executeRaw`
          INSERT INTO checkpoints (assignment_id, type, point, captured_at, note)
          VALUES (${assignmentId}::uuid, 'ARRIVED'::"CheckpointType",
                  ST_SetSRID(ST_MakePoint(${c.lng}::float8, ${c.lat}::float8), 4326)::geography,
                  ${capturedAt}::timestamptz, ${input.note ?? null})
        `;
      }
      return this.record(tx, a, 'ARRIVED', runnerId, {
        note: input.note,
        outbox: 'execution.arrived',
        extra: { hasLocation: Boolean(input.checkpoint) },
      });
    });
  }

  async resolveProblem(runnerId: string, assignmentId: string, problemId: string): Promise<ProblemDto> {
    await this.requireRunner(runnerId, assignmentId);
    return this.prisma.$transaction(async (tx) => {
      const a = await this.lockWorking(tx, assignmentId, runnerId, RECEIPT_WINDOW);
      const problem = await tx.executionProblem.findFirst({ where: { id: problemId, assignmentId } });
      if (!problem) {
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }
      if (problem.status !== 'OPEN') {
        throw DomainException.of(ASSIGNMENT_INVALID_STATE, { message: 'This problem is already resolved.' });
      }
      const now = await this.dbNow(tx);
      const updated = await tx.executionProblem.update({
        where: { id: problemId },
        data: { status: 'RESOLVED', resolvedAt: now, resolvedBy: runnerId },
      });
      const open = await tx.executionProblem.count({ where: { assignmentId, status: 'OPEN' } });
      await this.record(tx, a, 'PROBLEM_RESOLVED', runnerId, {
        metadata: { problemId },
        outbox: 'execution.problem_resolved',
        extra: { problemId, openProblems: open },
      });
      return this.toProblem(updated, open >= SUGGEST_DISPUTE_AT);
    });
  }

  async listProblems(userId: string, assignmentId: string): Promise<ProblemDto[]> {
    await this.requireParty(userId, assignmentId);
    const rows = await this.prisma.executionProblem.findMany({ where: { assignmentId }, orderBy: { createdAt: 'asc' } });
    const open = rows.filter((row) => row.status === 'OPEN').length;
    return rows.map((row) => this.toProblem(row, open >= SUGGEST_DISPUTE_AT));
  }

  /** A delay notice (Backend PRD 15.5): at most `MAX_DELAY_NOTICES_PER_ASSIGNMENT`. */
  async delayNotice(runnerId: string, assignmentId: string, input: DelayNoticeDto): Promise<ExecutionEventDto> {
    await this.requireRunner(runnerId, assignmentId);
    const limit = await this.config.get('MAX_DELAY_NOTICES_PER_ASSIGNMENT');
    return this.prisma.$transaction(async (tx) => {
      const a = await this.lockWorking(tx, assignmentId, runnerId, WORKING);
      const sent = await tx.executionEvent.count({ where: { assignmentId, type: 'DELAY_NOTICE' } });
      if (sent >= limit) {
        throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
          message: 'You have used all the delay notices for this errand.',
          details: { limit, sent },
        });
      }
      return this.record(tx, a, 'DELAY_NOTICE', runnerId, {
        note: input.note,
        metadata: { reason: input.reason, newEstimateMinutes: input.newEstimateMinutes },
        outbox: 'execution.delay_notified',
        extra: { reason: input.reason, newEstimateMinutes: input.newEstimateMinutes, notice: sent + 1 },
      });
    });
  }

  /** A purchase receipt photo, for Shopping and Purchase errands only. User evidence, never verified. */
  async addReceipt(runnerId: string, assignmentId: string, input: ReceiptDto): Promise<ExecutionEventDto> {
    await this.requireRunner(runnerId, assignmentId);
    await this.media.requireReadyOwned(runnerId, input.mediaId, 'PURCHASE_RECEIPT');
    const limit = await this.config.get('MAX_RECEIPTS_PER_ASSIGNMENT');
    return this.prisma.$transaction(async (tx) => {
      const a = await this.lockWorking(tx, assignmentId, runnerId, RECEIPT_WINDOW);
      if (a.categoryKey !== RECEIPT_CATEGORY_KEY) {
        throw DomainException.of(VALIDATION_ERROR, {
          message: 'Receipts are only for Shopping and Purchase errands.',
          details: { category: a.categoryKey },
        });
      }
      await this.assertMediaUnused(tx, input.mediaId);
      const added = await tx.executionEvent.count({ where: { assignmentId, type: 'RECEIPT_ADDED' } });
      if (added >= limit) {
        throw DomainException.of(ASSIGNMENT_INVALID_STATE, { message: 'You have added the most receipts allowed.', details: { limit, added } });
      }
      return this.record(tx, a, 'RECEIPT_ADDED', runnerId, {
        note: input.note,
        mediaId: input.mediaId,
        outbox: 'execution.receipt_added',
        extra: { receipt: added + 1 },
      });
    });
  }

  /** The errand timeline for either party (Backend PRD 15.1, 15.5). */
  async timeline(userId: string, assignmentId: string): Promise<ExecutionEventDto[]> {
    await this.requireParty(userId, assignmentId);
    const rows = await this.prisma.executionEvent.findMany({ where: { assignmentId }, orderBy: { createdAt: 'asc' } });
    return rows.map((row) => this.toEvent(row));
  }

  // ---- internals ----

  private async requireRunner(runnerId: string, assignmentId: string): Promise<void> {
    const found = await this.prisma.assignment.findFirst({ where: { id: assignmentId, runnerId }, select: { id: true } });
    if (!found) throw DomainException.of(RESOURCE_NOT_FOUND);
  }

  private async requireParty(userId: string, assignmentId: string): Promise<void> {
    const found = await this.prisma.assignment.findFirst({
      where: { id: assignmentId, OR: [{ requesterId: userId }, { runnerId: userId }] },
      select: { id: true },
    });
    if (!found) throw DomainException.of(RESOURCE_NOT_FOUND);
  }

  /**
   * Lock the errand (shared) then the assignment, and require an ACCEPTED assignment on an errand
   * in one of `statuses`.
   */
  private async lockWorking(tx: Prisma.TransactionClient, assignmentId: string, runnerId: string, statuses: readonly string[]): Promise<Locked> {
    const ids = await tx.$queryRaw<Array<{ errand_id: string }>>`
      SELECT errand_id::text FROM assignments WHERE id = ${assignmentId}::uuid AND deleted_at IS NULL
    `;
    if (!ids[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
    const errands = await tx.$queryRaw<Array<{ status: string; category_key: string }>>`
      SELECT e.status::text AS status, c.key AS category_key
      FROM errands e JOIN categories c ON c.id = e.category_id
      WHERE e.id = ${ids[0].errand_id}::uuid FOR SHARE OF e
    `;
    const rows = await tx.$queryRaw<Array<{ id: string; errand_id: string; requester_id: string; runner_id: string; status: string }>>`
      SELECT id::text, errand_id::text, requester_id::text, runner_id::text, status::text AS status
      FROM assignments WHERE id = ${assignmentId}::uuid AND deleted_at IS NULL FOR UPDATE
    `;
    const row = rows[0];
    if (!row || row.runner_id !== runnerId || !errands[0]) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (row.status !== 'ACCEPTED' || !statuses.includes(errands[0].status)) {
      throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
        message: 'This is not possible at this stage of the errand.',
        details: { assignmentStatus: row.status, errandStatus: errands[0].status },
      });
    }
    return {
      id: row.id,
      errandId: row.errand_id,
      requesterId: row.requester_id,
      runnerId: row.runner_id,
      errandStatus: errands[0].status,
      categoryKey: errands[0].category_key,
    };
  }

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

  private async record(
    tx: Prisma.TransactionClient,
    a: Locked,
    type: ExecutionEventType,
    actorId: string,
    options: { note?: string; mediaId?: string; metadata?: Record<string, unknown>; outbox: string; extra: Record<string, unknown> },
  ): Promise<ExecutionEventDto> {
    const event = await tx.executionEvent.create({
      data: {
        assignmentId: a.id,
        errandId: a.errandId,
        type,
        actorId,
        actorType: AuditActorType.USER,
        note: options.note,
        mediaId: options.mediaId,
        metadata: options.metadata as Prisma.InputJsonObject | undefined,
      },
    });
    await this.outbox.add(tx, {
      eventType: options.outbox,
      aggregateType: 'assignment',
      aggregateId: a.id,
      payload: {
        assignmentId: a.id,
        errandId: a.errandId,
        requesterId: a.requesterId,
        runnerId: a.runnerId,
        type,
        ...options.extra,
      },
    });
    await this.audit.recordInTransaction(tx, {
      actorType: AuditActorType.USER,
      actorId,
      action: `execution.${type.toLowerCase()}`,
      entityType: 'assignment',
      entityId: a.id,
      metadata: { errandId: a.errandId, ...options.extra },
    });
    return this.toEvent(event);
  }

  private toEvent(row: {
    id: string;
    type: ExecutionEventType;
    actorType: AuditActorType;
    actorId: string | null;
    note: string | null;
    mediaId: string | null;
    metadata: unknown;
    createdAt: Date;
  }): ExecutionEventDto {
    return {
      id: row.id,
      type: row.type,
      actorType: row.actorType,
      actorId: row.actorId,
      note: row.note,
      mediaId: row.mediaId,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      createdAt: row.createdAt,
    };
  }

  private toProblem(
    row: { id: string; assignmentId: string; type: string; note: string | null; mediaId: string | null; status: string; createdAt: Date; resolvedAt: Date | null },
    suggestDispute: boolean,
  ): ProblemDto {
    return {
      id: row.id,
      assignmentId: row.assignmentId,
      type: row.type,
      note: row.note,
      mediaId: row.mediaId,
      status: row.status,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
      suggestDispute,
    };
  }

  private async dbNow(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return rows[0].now;
  }
}

/** Purposes whose files are execution evidence, viewable by both parties of the assignment. */
export const EXECUTION_EVIDENCE_PURPOSES: MediaPurpose[] = ['PICKUP_EVIDENCE', 'DELIVERY_EVIDENCE', 'PURCHASE_RECEIPT'];

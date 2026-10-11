import { Injectable } from '@nestjs/common';
import { AuditActorType, ExecutionEventType, type NoShowReport, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ASSIGNMENT_CONFLICT, ASSIGNMENT_INVALID_STATE, RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import { ReliabilityService } from './reliability.service.js';
import type { NoShowReportDto, NoShowStateDto, ReportNoShowDto, RespondNoShowDto } from './no-show.dto.js';

interface Ctx {
  id: string;
  errand_id: string;
  requester_id: string;
  runner_id: string;
  status: string;
  accepted_at: Date | null;
  errand_status: string;
  time_mode: string | null;
  scheduled_at: Date | null;
  db_now: Date;
}

type Source = 'ACKNOWLEDGED' | 'NO_RESPONSE' | 'ADMIN';

export function toNoShowDto(row: NoShowReport, viewerId: string): NoShowReportDto {
  return {
    id: row.id,
    assignmentId: row.assignmentId,
    status: row.status,
    reportedByMe: row.reporterId === viewerId,
    note: row.note,
    responseDueAt: row.responseDueAt,
    respondedAt: row.respondedAt,
    resolvedAt: row.resolvedAt,
    resolutionSource: row.resolutionSource,
    createdAt: row.createdAt,
  };
}

/**
 * No-show reports (Backend PRD 21.1 definitions). One party reports that the other did not show up.
 * The report can be filed from `NO_SHOW_EARLIEST_REPORT_MINUTES` after the agreed time (the
 * schedule, or acceptance for an ASAP errand). The person reported is prompted and has
 * `NO_SHOW_PROMPT_MINUTES` to answer:
 *
 *   ACKNOWLEDGE or no answer in time  ->  CONFIRMED, a NO_SHOW fact (high severity) for them
 *   PRESENT                            ->  CONTESTED, waits for an admin to confirm or dismiss
 *
 * A confirmed no-show does not cancel the errand. The person who was left waiting can cancel
 * without a reliability penalty (the reliability handler excuses that cancellation).
 */
@Injectable()
export class NoShowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: BusinessConfigService,
    private readonly reliability: ReliabilityService,
  ) {}

  // ---- Reads ----

  async state(userId: string, assignmentId: string): Promise<NoShowStateDto> {
    const earliestMinutes = await this.config.get('NO_SHOW_EARLIEST_REPORT_MINUTES');
    const ctx = await this.context(this.prisma, userId, assignmentId, false);
    const report =
      (await this.prisma.noShowReport.findFirst({
        where: { assignmentId, deletedAt: null, status: { in: ['PENDING', 'CONTESTED'] } },
        orderBy: { createdAt: 'desc' },
      })) ??
      (await this.prisma.noShowReport.findFirst({ where: { assignmentId, deletedAt: null }, orderBy: { createdAt: 'desc' } }));
    const active = ctx.status === 'ACCEPTED' && ['ACCEPTED', 'IN_PROGRESS'].includes(ctx.errand_status);
    const earliest = active ? this.earliest(ctx, earliestMinutes) : null;
    const open = report !== null && ['PENDING', 'CONTESTED'].includes(report.status);
    return {
      report: report ? toNoShowDto(report, userId) : null,
      canReport: active && !open && earliest !== null && ctx.db_now.getTime() >= earliest.getTime(),
      earliestReportAt: earliest,
    };
  }

  // ---- Report and respond ----

  async report(userId: string, assignmentId: string, input: ReportNoShowDto): Promise<NoShowReportDto> {
    const [promptMinutes, earliestMinutes] = await Promise.all([
      this.config.get('NO_SHOW_PROMPT_MINUTES'),
      this.config.get('NO_SHOW_EARLIEST_REPORT_MINUTES'),
    ]);
    const created = await this.prisma.$transaction(async (tx) => {
      const ctx = await this.context(tx, userId, assignmentId, true);
      if (ctx.status !== 'ACCEPTED' || !['ACCEPTED', 'IN_PROGRESS'].includes(ctx.errand_status)) {
        throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
          message: 'A no-show can only be reported while the errand is accepted or in progress.',
          details: { status: ctx.status, errandStatus: ctx.errand_status },
        });
      }
      const earliest = this.earliest(ctx, earliestMinutes);
      if (earliest && ctx.db_now.getTime() < earliest.getTime()) {
        throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
          message: 'It is too early to report a no-show.',
          details: { reason: 'TOO_EARLY', earliestReportAt: earliest },
        });
      }
      const open = await tx.noShowReport.findFirst({
        where: { assignmentId, deletedAt: null, status: { in: ['PENDING', 'CONTESTED'] } },
        select: { id: true },
      });
      if (open) {
        throw DomainException.of(ASSIGNMENT_CONFLICT, { message: 'A no-show report is already open.', details: { reason: 'ALREADY_REPORTED' } });
      }

      const accusedId = ctx.requester_id === userId ? ctx.runner_id : ctx.requester_id;
      const due = new Date(ctx.db_now.getTime() + promptMinutes * 60_000);
      const row = await tx.noShowReport.create({
        data: {
          assignmentId,
          errandId: ctx.errand_id,
          reporterId: userId,
          accusedId,
          note: input.note?.trim() || null,
          responseDueAt: due,
        },
      });
      await tx.executionEvent.create({
        data: {
          assignmentId,
          errandId: ctx.errand_id,
          type: ExecutionEventType.NO_SHOW_REPORTED,
          actorId: userId,
          actorType: AuditActorType.USER,
        },
      });
      await this.outbox.add(tx, {
        eventType: 'no_show.reported',
        aggregateType: 'assignment',
        aggregateId: assignmentId,
        payload: this.payload(row, ctx, { responseDueAt: due, promptMinutes }),
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'no_show.reported',
        entityType: 'assignment',
        entityId: assignmentId,
        metadata: { reportId: row.id, errandId: ctx.errand_id, accusedId },
      });
      return row;
    });
    return toNoShowDto(created, userId);
  }

  async respond(userId: string, assignmentId: string, input: RespondNoShowDto): Promise<NoShowReportDto> {
    const points = (await this.reliability.pointsTable()).HIGH;
    const row = await this.prisma.$transaction(async (tx) => {
      const ctx = await this.context(tx, userId, assignmentId, true);
      const locked = await tx.$queryRaw<Array<{ id: string; accused_id: string; status: string; response_due_at: Date }>>`
        SELECT id::text, accused_id::text, status, response_due_at
        FROM no_show_reports
        WHERE assignment_id = ${assignmentId}::uuid AND status IN ('PENDING', 'CONTESTED') AND deleted_at IS NULL
        FOR UPDATE
      `;
      const open = locked[0];
      if (!open || open.accused_id !== userId) {
        // Nothing open, or the report is about the other person: only the person reported answers.
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }
      if (open.status !== 'PENDING') {
        return tx.noShowReport.findUniqueOrThrow({ where: { id: open.id } });
      }
      // A late answer settles as no answer, and returns the settled report rather than an error.
      if (ctx.db_now.getTime() >= open.response_due_at.getTime()) {
        return this.confirm(tx, open.id, ctx, 'NO_RESPONSE', points, { type: AuditActorType.WORKER });
      }
      if (input.response === 'ACKNOWLEDGE') {
        return this.confirm(tx, open.id, ctx, 'ACKNOWLEDGED', points, { type: AuditActorType.USER, id: userId });
      }
      const updated = await tx.noShowReport.update({
        where: { id: open.id },
        data: { status: 'CONTESTED', respondedAt: ctx.db_now },
      });
      await this.outbox.add(tx, {
        eventType: 'no_show.contested',
        aggregateType: 'assignment',
        aggregateId: assignmentId,
        payload: this.payload(updated, ctx, {}),
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'no_show.contested',
        entityType: 'assignment',
        entityId: assignmentId,
        metadata: { reportId: updated.id },
      });
      return updated;
    });
    return toNoShowDto(row, userId);
  }

  // ---- Scheduler and admin ----

  /** Confirm every report whose prompt window ended without an answer. Rows are claimed with SKIP LOCKED. */
  async confirmDue(batch = 100): Promise<number> {
    const points = (await this.reliability.pointsTable()).HIGH;
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<Array<{ id: string; assignment_id: string }>>`
        SELECT id::text, assignment_id::text FROM no_show_reports
        WHERE status = 'PENDING' AND response_due_at <= clock_timestamp() AND deleted_at IS NULL
        ORDER BY response_due_at
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED
      `;
      for (const report of due) {
        const ctx = await this.systemContext(tx, report.assignment_id);
        await this.confirm(tx, report.id, ctx, 'NO_RESPONSE', points, { type: AuditActorType.WORKER });
      }
      return due.length;
    });
  }

  /**
   * An admin decides a pending or contested report (the admin controller arrives with P11). A
   * confirmation records the NO_SHOW fact; a dismissal records nothing against anyone.
   */
  async adminResolve(
    reportId: string,
    outcome: 'CONFIRM' | 'DISMISS',
    actor: { adminId: string },
    reason: string,
  ): Promise<NoShowReport> {
    const points = (await this.reliability.pointsTable()).HIGH;
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; assignment_id: string; status: string }>>`
        SELECT id::text, assignment_id::text, status FROM no_show_reports
        WHERE id = ${reportId}::uuid AND deleted_at IS NULL FOR UPDATE
      `;
      const row = locked[0];
      if (!row) throw DomainException.of(RESOURCE_NOT_FOUND);
      if (!['PENDING', 'CONTESTED'].includes(row.status)) {
        throw DomainException.of(ASSIGNMENT_INVALID_STATE, { message: 'This report was already decided.', details: { status: row.status } });
      }
      const ctx = await this.systemContext(tx, row.assignment_id);
      if (outcome === 'CONFIRM') {
        return this.confirm(tx, reportId, ctx, 'ADMIN', points, { type: AuditActorType.ADMIN, id: actor.adminId }, reason);
      }
      const dismissed = await tx.noShowReport.update({
        where: { id: reportId },
        data: { status: 'DISMISSED', resolvedAt: ctx.db_now, resolutionSource: 'ADMIN', resolvedBy: actor.adminId },
      });
      await this.outbox.add(tx, {
        eventType: 'no_show.dismissed',
        aggregateType: 'assignment',
        aggregateId: dismissed.assignmentId,
        payload: this.payload(dismissed, ctx, {}),
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: actor.adminId,
        action: 'no_show.dismissed',
        entityType: 'assignment',
        entityId: dismissed.assignmentId,
        reasonCode: reason,
        metadata: { reportId },
      });
      return dismissed;
    });
  }

  // ---- Internals ----

  private async confirm(
    tx: Prisma.TransactionClient,
    reportId: string,
    ctx: Ctx,
    source: Source,
    points: number,
    actor: { type: AuditActorType; id?: string },
    reason?: string,
  ): Promise<NoShowReport> {
    const row = await tx.noShowReport.update({
      where: { id: reportId },
      data: {
        status: 'CONFIRMED',
        resolvedAt: ctx.db_now,
        resolutionSource: source,
        resolvedBy: actor.type === AuditActorType.ADMIN ? actor.id : undefined,
        respondedAt: source === 'ACKNOWLEDGED' ? ctx.db_now : undefined,
      },
    });
    await this.reliability.record(tx, {
      userId: row.accusedId,
      type: 'NO_SHOW',
      points,
      errandId: row.errandId,
      assignmentId: row.assignmentId,
      occurredAt: ctx.db_now,
      source: actor.type,
      actorId: actor.id,
      metadata: { reportId, reporterId: row.reporterId, source },
      dedupeKey: `no_show:${reportId}`,
    });
    await this.outbox.add(tx, {
      eventType: 'no_show.confirmed',
      aggregateType: 'assignment',
      aggregateId: row.assignmentId,
      payload: this.payload(row, ctx, { source }),
    });
    await this.audit.recordInTransaction(tx, {
      actorType: actor.type,
      actorId: actor.id,
      action: 'no_show.confirmed',
      entityType: 'assignment',
      entityId: row.assignmentId,
      reasonCode: reason,
      metadata: { reportId, source, accusedId: row.accusedId },
    });
    return row;
  }

  private payload(row: NoShowReport, ctx: Ctx, extra: Record<string, unknown>): Record<string, unknown> {
    return {
      reportId: row.id,
      assignmentId: row.assignmentId,
      errandId: row.errandId,
      requesterId: ctx.requester_id,
      runnerId: ctx.runner_id,
      reporterId: row.reporterId,
      accusedId: row.accusedId,
      ...extra,
    };
  }

  /** The agreed time plus the earliest-report delay, or null when there is no agreed time yet. */
  private earliest(ctx: Ctx, minutes: number): Date | null {
    const agreed = ctx.time_mode === 'SCHEDULED' && ctx.scheduled_at ? ctx.scheduled_at : ctx.accepted_at;
    return agreed ? new Date(agreed.getTime() + minutes * 60_000) : null;
  }

  /** The assignment and its errand as the party sees them; anyone else gets "not found". */
  private async context(
    client: Pick<Prisma.TransactionClient, '$queryRaw'>,
    userId: string,
    assignmentId: string,
    lock: boolean,
  ): Promise<Ctx> {
    const rows = lock
      ? await client.$queryRaw<Ctx[]>`
          SELECT a.id::text, a.errand_id::text, a.requester_id::text, a.runner_id::text, a.status::text AS status, a.accepted_at,
                 e.status::text AS errand_status, e.time_mode::text AS time_mode, e.scheduled_at, clock_timestamp() AS db_now
          FROM assignments a JOIN errands e ON e.id = a.errand_id
          WHERE a.id = ${assignmentId}::uuid AND a.deleted_at IS NULL
            AND (a.requester_id = ${userId}::uuid OR a.runner_id = ${userId}::uuid)
          FOR UPDATE OF a
        `
      : await client.$queryRaw<Ctx[]>`
          SELECT a.id::text, a.errand_id::text, a.requester_id::text, a.runner_id::text, a.status::text AS status, a.accepted_at,
                 e.status::text AS errand_status, e.time_mode::text AS time_mode, e.scheduled_at, clock_timestamp() AS db_now
          FROM assignments a JOIN errands e ON e.id = a.errand_id
          WHERE a.id = ${assignmentId}::uuid AND a.deleted_at IS NULL
            AND (a.requester_id = ${userId}::uuid OR a.runner_id = ${userId}::uuid)
        `;
    if (!rows[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
    return rows[0];
  }

  private async systemContext(tx: Prisma.TransactionClient, assignmentId: string): Promise<Ctx> {
    const rows = await tx.$queryRaw<Ctx[]>`
      SELECT a.id::text, a.errand_id::text, a.requester_id::text, a.runner_id::text, a.status::text AS status, a.accepted_at,
             e.status::text AS errand_status, e.time_mode::text AS time_mode, e.scheduled_at, clock_timestamp() AS db_now
      FROM assignments a JOIN errands e ON e.id = a.errand_id
      WHERE a.id = ${assignmentId}::uuid
    `;
    if (!rows[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
    return rows[0];
  }
}

import { Injectable, OnModuleInit } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { EventDispatcher, type DomainEvent, type DomainEventHandler } from '../queue/event-dispatcher.js';
import { ReliabilityService } from './reliability.service.js';
import {
  cancellationSeverity,
  isLateRequesterCancellation,
  type ReliabilityEventType,
  type ReliabilitySeverity,
} from './reliability.rules.js';

const str = (p: Record<string, unknown>, key: string): string | undefined => (typeof p[key] === 'string' ? (p[key] as string) : undefined);

const RANK: Record<ReliabilitySeverity, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

/**
 * Turns marketplace events into reliability facts (Backend PRD 21.1). Every fact has a dedupe key
 * built from the outbox event id, so a retried job writes nothing twice.
 *
 * Which party a fact belongs to is decided here from the event: a runner who declines, a requester
 * who cancels after acceptance. Facts that need a human decision (a confirmed no-show, an upheld
 * report, a false claim) are written by the case that decides them (NoShowService, disputes).
 */
@Injectable()
export class ReliabilityEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = 'ReliabilityEventHandler';

  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly reliability: ReliabilityService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload;
    const base = {
      errandId: str(p, 'errandId') ?? null,
      assignmentId: str(p, 'assignmentId') ?? null,
      occurredAt: new Date(event.occurredAt),
    };
    switch (event.eventType) {
      case 'offer.created':
        return this.write(event, str(p, 'runnerId'), 'OFFER_SUBMITTED', { ...base, assignmentId: null });
      case 'assignment.accepted':
        return this.write(event, str(p, 'runnerId'), 'ASSIGNMENT_ACCEPTED', base);
      case 'assignment.declined':
        return this.write(event, str(p, 'runnerId'), 'ASSIGNMENT_DECLINED', base);
      case 'assignment.timed_out':
        return this.write(event, str(p, 'runnerId'), 'ASSIGNMENT_TIMEOUT', { ...base, source: AuditActorType.SYSTEM });
      case 'execution.started':
        return this.write(event, str(p, 'runnerId'), 'EXECUTION_STARTED', base);
      case 'execution.picked_up':
        return this.write(event, str(p, 'runnerId'), 'PICKUP_CONFIRMED', base);
      case 'execution.delivered':
        return this.write(event, str(p, 'runnerId'), 'DELIVERY_CONFIRMED', base);
      case 'assignment.cancelled':
        return this.cancelled(event, base);
      case 'errand.completed':
        return this.completed(event, base);
      case 'errand.disputed':
        return this.disputed(event, base);
      default:
        return;
    }
  }

  private async write(
    event: DomainEvent,
    userId: string | undefined,
    type: ReliabilityEventType,
    options: {
      errandId: string | null;
      assignmentId: string | null;
      occurredAt: Date;
      source?: AuditActorType;
      severity?: ReliabilitySeverity;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!userId) return;
    await this.reliability.recordStandalone({
      userId,
      type,
      errandId: options.errandId,
      assignmentId: options.assignmentId,
      occurredAt: options.occurredAt,
      source: options.source ?? AuditActorType.WORKER,
      severity: options.severity,
      metadata: { event: event.eventType, ...options.metadata },
      dedupeKey: `${event.eventId}:${type}:${userId}`,
    });
  }

  /**
   * A cancellation counts against the party who cancelled, by the stage it happened at. An admin
   * or the system cancelling is nobody's fault. A cancel by the party who was left waiting after a
   * confirmed no-show is excused (recorded with no points).
   */
  private async cancelled(
    event: DomainEvent,
    base: { errandId: string | null; assignmentId: string | null; occurredAt: Date },
  ): Promise<void> {
    const p = event.payload;
    const actorType = str(p, 'actorType');
    if (actorType !== 'REQUESTER' && actorType !== 'RUNNER') return;
    const requesterId = str(p, 'requesterId');
    const runnerId = str(p, 'runnerId');
    const userId = actorType === 'REQUESTER' ? requesterId : runnerId;
    const otherId = actorType === 'REQUESTER' ? runnerId : requesterId;
    if (!userId || !otherId) return;
    const stage = str(p, 'stage') ?? null;

    let severity = cancellationSeverity(stage);
    let type: ReliabilityEventType = 'ASSIGNMENT_CANCELLED';
    if (actorType === 'REQUESTER' && base.errandId && severity !== 'NONE') {
      const [lead, errand] = await Promise.all([
        this.config.get('LATE_CANCELLATION_MINUTES_BEFORE_START'),
        this.prisma.errand.findFirst({ where: { id: base.errandId }, select: { scheduledAt: true } }),
      ]);
      if (isLateRequesterCancellation({ scheduledAt: errand?.scheduledAt ?? null, cancelledAt: base.occurredAt, leadMinutes: lead })) {
        type = 'LATE_CANCELLATION';
        if (RANK[severity] < RANK.MEDIUM) severity = 'MEDIUM';
      }
    }

    let metadata: Record<string, unknown> = { stage, actorType, reason: str(p, 'reason') ?? null };
    if (severity !== 'NONE' && base.assignmentId) {
      const excused = await this.prisma.noShowReport.findFirst({
        where: { assignmentId: base.assignmentId, status: 'CONFIRMED', accusedId: otherId, deletedAt: null },
        select: { id: true },
      });
      if (excused) {
        severity = 'NONE';
        metadata = { ...metadata, excused: 'NO_SHOW_CONFIRMED', noShowReportId: excused.id };
      }
    }
    await this.write(event, userId, type, { ...base, severity, metadata });
  }

  /** A completed errand is a positive fact for both parties. */
  private async completed(event: DomainEvent, base: { errandId: string | null; occurredAt: Date }): Promise<void> {
    if (!base.errandId) return;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; requester_id: string; runner_id: string }>>`
      SELECT id::text, requester_id::text, runner_id::text FROM assignments
      WHERE errand_id = ${base.errandId}::uuid AND status = 'COMPLETED'::"AssignmentStatus" AND deleted_at IS NULL
    `;
    const automatic = str(event.payload, 'actorType') === 'SYSTEM';
    const type: ReliabilityEventType = automatic ? 'ERRAND_AUTO_COMPLETED' : 'ERRAND_COMPLETED';
    for (const row of rows) {
      for (const userId of [row.requester_id, row.runner_id]) {
        await this.write(event, userId, type, { ...base, assignmentId: row.id });
      }
    }
  }

  /** A dispute is a neutral fact for both parties; the outcome and any fault are decided by the case. */
  private async disputed(event: DomainEvent, base: { errandId: string | null; occurredAt: Date }): Promise<void> {
    if (!base.errandId) return;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; requester_id: string; runner_id: string }>>`
      SELECT id::text, requester_id::text, runner_id::text FROM assignments
      WHERE errand_id = ${base.errandId}::uuid AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `;
    for (const row of rows) {
      for (const userId of [row.requester_id, row.runner_id]) {
        await this.write(event, userId, 'ERRAND_DISPUTED', { ...base, assignmentId: row.id });
      }
    }
  }
}

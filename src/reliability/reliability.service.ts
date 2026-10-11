import { Injectable } from '@nestjs/common';
import { AuditActorType, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import {
  SEVERITY_BY_TYPE,
  type ReliabilityEventType,
  type ReliabilitySeverity,
} from './reliability.rules.js';

export interface PointsTable {
  NONE: number;
  LOW: number;
  MEDIUM: number;
  HIGH: number;
}

export interface RecordReliabilityInput {
  userId: string;
  type: ReliabilityEventType;
  /** Points for this fact. Resolve with `pointsFor` before the transaction (it may read config). */
  points: number;
  errandId?: string | null;
  assignmentId?: string | null;
  occurredAt?: Date;
  source: AuditActorType;
  /** The admin or user that caused the fact, for the audit row of an admin-recorded event. */
  actorId?: string | null;
  metadata?: Record<string, unknown>;
  /** One value per fact: a retried consumer then writes it once. */
  dedupeKey: string;
}

export interface ReliabilityEventView {
  id: string;
  type: string;
  points: number;
  occurredAt: Date;
  errandId: string | null;
  assignmentId: string | null;
  source: string;
  metadata: unknown;
}

export interface ReliabilityExplanation {
  windowDays: number;
  /** Sum of the points of the events in the window. */
  points: number;
  thresholds: { warning: number; restriction: number; suspension: number; adminReview: number };
  /** The highest threshold already reached, or null. */
  reached: 'WARNING' | 'RESTRICTION' | 'SUSPENSION' | 'ADMIN_REVIEW' | null;
  /** Every event that contributes, newest first. */
  events: ReliabilityEventView[];
}

/**
 * Reliability is a record of objective facts, not a mutable score (Backend PRD 21.1). Everything
 * derived from it (points in the rolling window, the explanation) is computed from the events, so
 * the same set of events always gives the same answer and every point can be traced.
 *
 * Positive events carry 0 points and never erase negative ones.
 */
@Injectable()
export class ReliabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /** The configured points per severity class. Read it before opening a transaction. */
  async pointsTable(): Promise<PointsTable> {
    const [low, medium, high] = await Promise.all([
      this.config.get('RELIABILITY_POINTS_LOW'),
      this.config.get('RELIABILITY_POINTS_MEDIUM'),
      this.config.get('RELIABILITY_POINTS_HIGH'),
    ]);
    return { NONE: 0, LOW: low, MEDIUM: medium, HIGH: high };
  }

  /** Points for an event type that has a fixed class. Cancellations pass the class they computed. */
  pointsFor(table: PointsTable, type: ReliabilityEventType, severity?: ReliabilitySeverity): number {
    if (severity) return table[severity];
    if (type === 'ASSIGNMENT_CANCELLED') {
      throw new Error('ASSIGNMENT_CANCELLED needs an explicit severity (it depends on the stage).');
    }
    return table[SEVERITY_BY_TYPE[type]];
  }

  /**
   * Write one fact inside the caller's transaction. Returns whether it was new: a repeat of the
   * same `dedupeKey` writes nothing and raises no event. A fact with points raises
   * `reliability.recorded`, which the enforcement ladder consumes (P9-04).
   */
  async record(tx: Prisma.TransactionClient, input: RecordReliabilityInput): Promise<{ created: boolean; id: string | null }> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO reliability_events (user_id, errand_id, assignment_id, event_type, severity, occurred_at, source, metadata, dedupe_key)
      VALUES (
        ${input.userId}::uuid, ${input.errandId ?? null}::uuid, ${input.assignmentId ?? null}::uuid,
        ${input.type}, ${input.points}::smallint,
        COALESCE(${input.occurredAt ?? null}::timestamptz, clock_timestamp()),
        ${input.source}::"AuditActorType",
        ${input.metadata ? JSON.stringify(input.metadata) : null}::jsonb,
        ${input.dedupeKey}
      )
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id::text
    `;
    const id = rows[0]?.id ?? null;
    if (!id) return { created: false, id: null };

    if (input.points > 0) {
      await this.outbox.add(tx, {
        eventType: 'reliability.recorded',
        aggregateType: 'user',
        aggregateId: input.userId,
        payload: {
          reliabilityEventId: id,
          userId: input.userId,
          eventType: input.type,
          points: input.points,
          errandId: input.errandId ?? null,
          assignmentId: input.assignmentId ?? null,
        },
      });
    }
    if (input.source === AuditActorType.ADMIN) {
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: input.actorId ?? undefined,
        action: 'reliability.recorded',
        entityType: 'reliability_event',
        entityId: id,
        metadata: { userId: input.userId, eventType: input.type, points: input.points },
      });
    }
    return { created: true, id };
  }

  /** Record outside a transaction (event consumers). */
  async recordStandalone(input: Omit<RecordReliabilityInput, 'points'> & { severity?: ReliabilitySeverity }): Promise<boolean> {
    const table = await this.pointsTable();
    const points = this.pointsFor(table, input.type, input.severity);
    const { severity: _severity, ...rest } = input;
    void _severity;
    return this.prisma.$transaction(async (tx) => (await this.record(tx, { ...rest, points })).created);
  }

  /** Points in the rolling window (`RELIABILITY_WINDOW_DAYS`), counted from the database clock. */
  async windowPoints(client: Pick<Prisma.TransactionClient, '$queryRaw'>, userId: string): Promise<number> {
    const days = await this.config.get('RELIABILITY_WINDOW_DAYS');
    const rows = await client.$queryRaw<Array<{ points: number }>>`
      SELECT COALESCE(SUM(severity), 0)::int AS points
      FROM reliability_events
      WHERE user_id = ${userId}::uuid AND severity > 0
        AND occurred_at > clock_timestamp() - make_interval(days => ${days}::int)
    `;
    return rows[0]?.points ?? 0;
  }

  /** Every event that contributes to the user's points, with the thresholds. */
  async explain(userId: string): Promise<ReliabilityExplanation> {
    const [days, warning, restriction, suspension, adminReview] = await Promise.all([
      this.config.get('RELIABILITY_WINDOW_DAYS'),
      this.config.get('LADDER_WARNING_POINTS'),
      this.config.get('LADDER_RESTRICTION_POINTS'),
      this.config.get('LADDER_SUSPENSION_POINTS'),
      this.config.get('LADDER_ADMIN_REVIEW_POINTS'),
    ]);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        event_type: string;
        severity: number;
        occurred_at: Date;
        errand_id: string | null;
        assignment_id: string | null;
        source: string;
        metadata: unknown;
      }>
    >`
      SELECT id::text, event_type, severity::int AS severity, occurred_at, errand_id::text, assignment_id::text,
             source::text AS source, metadata
      FROM reliability_events
      WHERE user_id = ${userId}::uuid AND severity > 0
        AND occurred_at > clock_timestamp() - make_interval(days => ${days}::int)
      ORDER BY occurred_at DESC, id DESC
    `;
    const points = rows.reduce((sum, row) => sum + row.severity, 0);
    const reached =
      points >= adminReview ? 'ADMIN_REVIEW' : points >= suspension ? 'SUSPENSION' : points >= restriction ? 'RESTRICTION' : points >= warning ? 'WARNING' : null;
    return {
      windowDays: days,
      points,
      thresholds: { warning, restriction, suspension, adminReview },
      reached,
      events: rows.map((row) => ({
        id: row.id,
        type: row.event_type,
        points: row.severity,
        occurredAt: row.occurred_at,
        errandId: row.errand_id,
        assignmentId: row.assignment_id,
        source: row.source,
        metadata: row.metadata,
      })),
    };
  }
}

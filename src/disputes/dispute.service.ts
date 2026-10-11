import { Injectable } from '@nestjs/common';
import { AuditActorType, type Dispute, type DisputeResolution, type EvidenceLink, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { ErrandStateService } from '../errands/errand-state.service.js';
import { ReliabilityService } from '../reliability/reliability.service.js';
import { EnforcementService } from '../enforcement/enforcement.service.js';
import type { ReliabilityEventType } from '../reliability/reliability.rules.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  ASSIGNMENT_INVALID_STATE,
  DISPUTE_ALREADY_OPEN,
  ERRAND_INVALID_STATE,
  RESOURCE_NOT_FOUND,
  VALIDATION_ERROR,
} from '../common/constants/error-codes.js';
import { EvidenceService } from './evidence.service.js';
import type { DisputeDto, EvidenceDto, EvidenceItemDto, OpenDisputeDto } from './dispute.dto.js';

const OPEN_STATUSES = ['OPEN', 'UNDER_REVIEW'] as const;

/** Reliability facts an admin may record when deciding a case (Backend PRD 21.1). */
export const ADMIN_RECORDABLE_FACTS = [
  'FALSE_NON_COMPLETION_CLAIM',
  'NO_SHOW',
  'LATE_CANCELLATION',
  'NO_RESPONSE_AFTER_ACCEPT',
  'VALID_REPORT_UPHELD',
] as const satisfies readonly ReliabilityEventType[];

export interface ResolveDisputeInput {
  outcome: DisputeResolution;
  notes: string;
  /** Facts the decision records against a party (the loser of a false claim, a no-show...). */
  facts?: Array<{ userId: string; type: (typeof ADMIN_RECORDABLE_FACTS)[number] }>;
  /** Parties to put in front of an admin as a severe event (a safety incident, fraud): skips the ladder. */
  escalate?: Array<{ userId: string; reason: string }>;
}

type DisputeWithEvidence = Dispute & { evidence: EvidenceLink[] };

export function toEvidenceDto(row: EvidenceLink, viewerId: string): EvidenceDto {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    statement: row.statement,
    addedByMe: row.addedBy === viewerId,
    createdAt: row.createdAt,
  };
}

export function toDisputeDto(row: DisputeWithEvidence, viewerId: string): DisputeDto {
  const open = (OPEN_STATUSES as readonly string[]).includes(row.status);
  return {
    id: row.id,
    errandId: row.errandId,
    assignmentId: row.assignmentId,
    openedByMe: row.openedBy === viewerId,
    type: row.type,
    status: row.status,
    claim: row.claim,
    resolution: row.resolution,
    resolutionNotes: row.resolutionNotes,
    resolvedAt: row.resolvedAt,
    firstResponseDueAt: row.slaDueAt,
    resolutionDueAt: row.resolutionDueAt,
    canAddEvidence: open,
    evidence: [...row.evidence].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((e) => toEvidenceDto(e, viewerId)),
    createdAt: row.createdAt,
  };
}

/**
 * Disputes (Backend PRD 21.3): a structured case about an errand that can change its outcome.
 *
 * - Opening one (a party, while the errand is ACCEPTED through DELIVERED) moves the errand to
 *   DISPUTED through the state machine, which stores the status it came from and clears the
 *   auto-completion deadline. One open dispute per assignment.
 * - An admin resolves it with COMPLETE (errand COMPLETED), CANCEL (CANCELLED) or DISMISS (back to
 *   the pre-dispute status). Urgent.ng does not settle money.
 * - Every resolution is audited and records DISPUTE_RESOLVED for both parties, plus any fact the
 *   admin chose to record.
 */
@Injectable()
export class DisputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: BusinessConfigService,
    private readonly errandState: ErrandStateService,
    private readonly evidence: EvidenceService,
    private readonly reliability: ReliabilityService,
    private readonly enforcement: EnforcementService,
  ) {}

  // ---- Open ----

  async open(userId: string, assignmentId: string, input: OpenDisputeDto): Promise<DisputeDto> {
    const [firstHours, resolveDays] = await Promise.all([
      this.config.get('DISPUTE_FIRST_RESPONSE_HOURS'),
      this.config.get('DISPUTE_RESOLUTION_DAYS'),
    ]);
    const maxEvidence = await this.config.get('DISPUTE_MAX_EVIDENCE_ITEMS');
    if ((input.evidence?.length ?? 0) > maxEvidence) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'Too many evidence items.', details: { field: 'evidence' } });
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const assignment = await tx.assignment.findFirst({
        where: { id: assignmentId, deletedAt: null, OR: [{ requesterId: userId }, { runnerId: userId }] },
        select: { id: true, errandId: true, requesterId: true, runnerId: true, status: true },
      });
      if (!assignment) {
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }
      const already = await tx.dispute.findFirst({
        where: { assignmentId, deletedAt: null, status: { in: [...OPEN_STATUSES] } },
        select: { id: true },
      });
      if (already) {
        throw DomainException.of(DISPUTE_ALREADY_OPEN, { details: { disputeId: already.id } });
      }
      const role = assignment.requesterId === userId ? 'REQUESTER' : 'RUNNER';

      let disputeId = '';
      await this.errandState.transition(tx, {
        errandId: assignment.errandId,
        to: 'DISPUTED',
        expectedFrom: ['ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED'],
        actor: { type: role, id: userId },
        reason: 'A dispute was opened.',
        eventPayload: { assignmentId, runnerId: assignment.runnerId, disputeType: input.type },
        apply: async (inner) => {
          // The assignment must still be live: a dispute is about work that is under way.
          const live = await inner.$queryRaw<Array<{ status: string }>>`
            SELECT status::text AS status FROM assignments WHERE id = ${assignmentId}::uuid FOR UPDATE
          `;
          if (live[0]?.status !== 'ACCEPTED') {
            throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
              message: 'A dispute can only be opened on an accepted assignment.',
              details: { status: live[0]?.status ?? null },
            });
          }
          const dueRows = await inner.$queryRaw<Array<{ first: Date; resolve: Date }>>`
            SELECT clock_timestamp() + make_interval(hours => ${firstHours}::int) AS first,
                   clock_timestamp() + make_interval(days => ${resolveDays}::int) AS resolve
          `;
          const dispute = await inner.dispute.create({
            data: {
              errandId: assignment.errandId,
              assignmentId,
              openedBy: userId,
              type: input.type,
              claim: input.claim.trim(),
              slaDueAt: dueRows[0].first,
              resolutionDueAt: dueRows[0].resolve,
            },
          });
          disputeId = dispute.id;
          for (const item of input.evidence ?? []) {
            await this.evidence.add(inner, { disputeId }, userId, item, { errandId: assignment.errandId, assignmentId });
          }
        },
      });

      await this.outbox.add(tx, {
        eventType: 'dispute.created',
        aggregateType: 'dispute',
        aggregateId: disputeId,
        payload: {
          disputeId,
          errandId: assignment.errandId,
          assignmentId,
          openedBy: userId,
          requesterId: assignment.requesterId,
          runnerId: assignment.runnerId,
          type: input.type,
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'dispute.opened',
        entityType: 'dispute',
        entityId: disputeId,
        metadata: { errandId: assignment.errandId, assignmentId, type: input.type },
      });
      return tx.dispute.findUniqueOrThrow({ where: { id: disputeId }, include: { evidence: true } });
    });
    return toDisputeDto(created, userId);
  }

  // ---- Read and add evidence ----

  async get(userId: string, disputeId: string): Promise<DisputeDto> {
    const row = await this.findForParty(this.prisma, userId, disputeId);
    return toDisputeDto(row, userId);
  }

  async addEvidence(userId: string, disputeId: string, item: EvidenceItemDto): Promise<DisputeDto> {
    const max = await this.config.get('DISPUTE_MAX_EVIDENCE_ITEMS');
    const row = await this.prisma.$transaction(async (tx) => {
      const dispute = await this.findForParty(tx, userId, disputeId);
      if (!(OPEN_STATUSES as readonly string[]).includes(dispute.status)) {
        throw DomainException.of(ERRAND_INVALID_STATE, {
          message: 'This dispute is closed. Evidence can no longer be added.',
          details: { reason: 'DISPUTE_CLOSED' },
        });
      }
      const mine = dispute.evidence.filter((e) => e.addedBy === userId).length;
      if (mine >= max) {
        throw DomainException.of(VALIDATION_ERROR, { message: 'You have added the most evidence items allowed.', details: { field: 'evidence' } });
      }
      await this.evidence.add(tx, { disputeId }, userId, item, { errandId: dispute.errandId, assignmentId: dispute.assignmentId });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'dispute.evidence_added',
        entityType: 'dispute',
        entityId: disputeId,
        metadata: { sourceType: item.sourceType, sourceId: item.sourceId ?? null },
      });
      return tx.dispute.findUniqueOrThrow({ where: { id: disputeId }, include: { evidence: true } });
    });
    return toDisputeDto(row, userId);
  }

  // ---- Admin (controllers arrive with P11) ----

  /** The first admin response: the case is under review. Sets the SLA marker once. */
  async adminStartReview(disputeId: string, actor: { adminId: string }): Promise<Dispute> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lockOpen(tx, disputeId);
      const updated = await tx.dispute.update({
        where: { id: row.id },
        data: { status: 'UNDER_REVIEW', firstResponseAt: row.firstResponseAt ?? new Date() },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: actor.adminId,
        action: 'dispute.review_started',
        entityType: 'dispute',
        entityId: disputeId,
      });
      return updated;
    });
  }

  /**
   * Decide a dispute. The errand moves through the state machine with actor ADMIN, so the
   * assignment, offers and notifications follow without any status written here.
   */
  async adminResolve(disputeId: string, input: ResolveDisputeInput, actor: { adminId: string }): Promise<Dispute> {
    const table = await this.reliability.pointsTable();
    const notes = input.notes.trim();
    if (!notes) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'A resolution needs notes.', details: { field: 'notes' } });
    }
    return this.prisma.$transaction(async (tx) => {
      const dispute = await this.lockOpen(tx, disputeId);
      const errand = await tx.$queryRaw<Array<{ status: string; status_before_dispute: string | null }>>`
        SELECT status::text AS status, status_before_dispute::text AS status_before_dispute
        FROM errands WHERE id = ${dispute.errandId}::uuid
      `;
      const before = errand[0]?.status_before_dispute ?? null;
      const to =
        input.outcome === 'COMPLETE' ? 'COMPLETED' : input.outcome === 'CANCEL' ? 'CANCELLED' : (before as 'ACCEPTED' | 'IN_PROGRESS' | 'PICKED_UP' | 'DELIVERED' | null);
      if (!to) {
        throw DomainException.of(ERRAND_INVALID_STATE, { message: 'The errand has no earlier status to return to.' });
      }
      const assignment = await tx.assignment.findUniqueOrThrow({
        where: { id: dispute.assignmentId },
        select: { requesterId: true, runnerId: true },
      });
      for (const fact of [...(input.facts ?? []), ...(input.escalate ?? [])]) {
        if (fact.userId !== assignment.requesterId && fact.userId !== assignment.runnerId) {
          throw DomainException.of(VALIDATION_ERROR, { message: 'A recorded fact must be about a party of the dispute.', details: { field: 'facts' } });
        }
      }

      // The dispute is marked decided first: a DISMISS back to DELIVERED must not find it still open
      // and hold the auto-completion window it is about to restart.
      const updated = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: 'RESOLVED',
          resolution: input.outcome,
          resolutionNotes: notes,
          resolvedBy: actor.adminId,
          resolvedAt: new Date(),
          firstResponseAt: dispute.firstResponseAt ?? new Date(),
        },
      });

      await this.errandState.transition(tx, {
        errandId: dispute.errandId,
        to,
        expectedFrom: 'DISPUTED',
        actor: { type: 'ADMIN', id: actor.adminId },
        reason: `Dispute resolved as ${input.outcome}.`,
        cancellation: input.outcome === 'CANCEL' ? { reason: 'ADMIN_CANCELLED', note: notes } : undefined,
        eventPayload: { disputeId, outcome: input.outcome },
      });

      const occurredAt = new Date();
      for (const userId of [assignment.requesterId, assignment.runnerId]) {
        await this.reliability.record(tx, {
          userId,
          type: 'DISPUTE_RESOLVED',
          points: 0,
          errandId: dispute.errandId,
          assignmentId: dispute.assignmentId,
          occurredAt,
          source: AuditActorType.ADMIN,
          actorId: actor.adminId,
          metadata: { disputeId, outcome: input.outcome },
          dedupeKey: `dispute:${disputeId}:resolved:${userId}`,
        });
      }
      for (const fact of input.facts ?? []) {
        await this.reliability.record(tx, {
          userId: fact.userId,
          type: fact.type,
          points: this.reliability.pointsFor(table, fact.type),
          errandId: dispute.errandId,
          assignmentId: dispute.assignmentId,
          occurredAt,
          source: AuditActorType.ADMIN,
          actorId: actor.adminId,
          metadata: { disputeId, outcome: input.outcome },
          dedupeKey: `dispute:${disputeId}:fact:${fact.type}:${fact.userId}`,
        });
      }

      for (const item of input.escalate ?? []) {
        await this.enforcement.flagSevere(tx, item.userId, { reason: item.reason, caseRef: `dispute:${disputeId}` });
      }

      await this.outbox.add(tx, {
        eventType: 'dispute.resolved',
        aggregateType: 'dispute',
        aggregateId: disputeId,
        payload: {
          disputeId,
          errandId: dispute.errandId,
          assignmentId: dispute.assignmentId,
          requesterId: assignment.requesterId,
          runnerId: assignment.runnerId,
          outcome: input.outcome,
          errandStatus: to,
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: actor.adminId,
        action: 'dispute.resolved',
        entityType: 'dispute',
        entityId: disputeId,
        reasonCode: input.outcome,
        metadata: { errandId: dispute.errandId, to, facts: (input.facts ?? []).map((f) => f.type) },
      });
      return updated;
    });
  }

  // ---- Internals ----

  /** The dispute, for one of its two parties. Anyone else gets "not found", never a hint it exists. */
  private async findForParty(
    client: Pick<Prisma.TransactionClient, 'dispute' | 'assignment'>,
    userId: string,
    disputeId: string,
  ): Promise<DisputeWithEvidence> {
    const row = await client.dispute.findFirst({ where: { id: disputeId, deletedAt: null }, include: { evidence: true } });
    if (!row) throw DomainException.of(RESOURCE_NOT_FOUND);
    const party = await client.assignment.findFirst({
      where: { id: row.assignmentId, OR: [{ requesterId: userId }, { runnerId: userId }] },
      select: { id: true },
    });
    if (!party) throw DomainException.of(RESOURCE_NOT_FOUND);
    return row;
  }

  private async lockOpen(tx: Prisma.TransactionClient, disputeId: string): Promise<Dispute> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM disputes
      WHERE id = ${disputeId}::uuid AND deleted_at IS NULL AND status IN ('OPEN'::"DisputeStatus", 'UNDER_REVIEW'::"DisputeStatus")
      FOR UPDATE
    `;
    if (!locked[0]) {
      const exists = await tx.dispute.findFirst({ where: { id: disputeId, deletedAt: null }, select: { id: true } });
      throw exists
        ? DomainException.of(ERRAND_INVALID_STATE, { message: 'This dispute was already decided.', details: { reason: 'DISPUTE_CLOSED' } })
        : DomainException.of(RESOURCE_NOT_FOUND);
    }
    return tx.dispute.findUniqueOrThrow({ where: { id: disputeId } });
  }
}

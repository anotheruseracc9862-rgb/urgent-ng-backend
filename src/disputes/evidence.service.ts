import { Injectable } from '@nestjs/common';
import type { EvidenceLink, EvidenceSourceType, Prisma } from '@prisma/client';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { MEDIA_INVALID, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { MediaService } from '../media/media.service.js';

export type CaseRef = { disputeId: string } | { reportId: string };

export interface EvidenceInput {
  sourceType: EvidenceSourceType;
  sourceId?: string;
  statement?: string;
}

/** What the case is about, so evidence can be checked to belong to it. */
export interface EvidenceScope {
  errandId: string | null;
  assignmentId: string | null;
}

export const MAX_STATEMENT_LENGTH = 2000;

/**
 * Evidence for a report or a dispute (Backend PRD 21.3). Every item keeps its source id, so the
 * case can always be traced to the message, photo, checkpoint or event it rests on. A user can
 * attach only what they are allowed to see in this errand: their own chat messages, their own
 * uploaded dispute photos, and the checkpoints and events of the assignment. There is no payment
 * evidence in the product, so there is no such source type.
 */
@Injectable()
export class EvidenceService {
  constructor(private readonly media: MediaService) {}

  /** Check one item and write it inside the caller's transaction. */
  async add(
    tx: Prisma.TransactionClient,
    ref: CaseRef,
    userId: string,
    input: EvidenceInput,
    scope: EvidenceScope,
  ): Promise<EvidenceLink> {
    const statement = input.statement?.trim() || null;
    if (input.sourceType === 'STATEMENT') {
      if (!statement) {
        throw DomainException.of(VALIDATION_ERROR, { message: 'A statement needs text.', details: { field: 'statement' } });
      }
      if (statement.length > MAX_STATEMENT_LENGTH) {
        throw DomainException.of(VALIDATION_ERROR, { message: 'The statement is too long.', details: { field: 'statement' } });
      }
    } else {
      if (!input.sourceId) {
        throw DomainException.of(VALIDATION_ERROR, { message: 'An evidence item needs its source.', details: { field: 'sourceId' } });
      }
      await this.checkSource(tx, userId, input.sourceType, input.sourceId, scope);
    }
    return tx.evidenceLink.create({
      data: {
        ...('disputeId' in ref ? { disputeId: ref.disputeId } : { reportId: ref.reportId }),
        sourceType: input.sourceType,
        sourceId: input.sourceType === 'STATEMENT' ? null : (input.sourceId ?? null),
        statement,
        addedBy: userId,
      },
    });
  }

  private async checkSource(
    tx: Prisma.TransactionClient,
    userId: string,
    type: EvidenceSourceType,
    sourceId: string,
    scope: EvidenceScope,
  ): Promise<void> {
    const outside = () =>
      DomainException.of(VALIDATION_ERROR, {
        message: 'That item is not part of this errand.',
        details: { field: 'sourceId', sourceType: type },
      });

    if (type === 'MESSAGE') {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT m.id::text FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = ${sourceId}::uuid AND m.deleted_at IS NULL AND c.deleted_at IS NULL
          AND (c.requester_id = ${userId}::uuid OR c.runner_id = ${userId}::uuid)
          AND (${scope.errandId}::uuid IS NULL OR c.errand_id = ${scope.errandId}::uuid)
      `;
      if (rows.length === 0) throw outside();
      return;
    }
    if (type === 'MEDIA') {
      // Owned by the user, READY and of the dispute-evidence purpose; a file is attached once.
      await this.media.requireReadyOwned(userId, sourceId, 'DISPUTE_EVIDENCE');
      const used = await tx.evidenceLink.findFirst({ where: { sourceType: 'MEDIA', sourceId }, select: { id: true } });
      if (used) throw DomainException.of(MEDIA_INVALID);
      return;
    }
    if (!scope.assignmentId) throw outside();
    if (type === 'CHECKPOINT') {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM checkpoints WHERE id = ${sourceId}::uuid AND assignment_id = ${scope.assignmentId}::uuid
      `;
      if (rows.length === 0) throw outside();
      return;
    }
    if (type === 'EXECUTION_EVENT') {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM execution_events WHERE id = ${sourceId}::uuid AND assignment_id = ${scope.assignmentId}::uuid
      `;
      if (rows.length === 0) throw outside();
    }
  }
}

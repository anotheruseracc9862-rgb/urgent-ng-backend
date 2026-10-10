import { Injectable } from '@nestjs/common';
import { AuditActorType, type PaymentAgreement, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ASSIGNMENT_INVALID_STATE, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import type { PaymentAgreementDto, UpdatePaymentAgreementDto } from './payment-agreement.dto.js';

export function toPaymentAgreementDto(row: PaymentAgreement): PaymentAgreementDto {
  return {
    assignmentId: row.assignmentId,
    agreedAmountMinor: Number(row.agreedAmountMinor),
    currency: row.currency,
    paymentMethod: row.paymentMethod,
    paymentTiming: row.paymentTiming,
    confirmedByRequesterAt: row.confirmedByRequesterAt,
    confirmedByRunnerAt: row.confirmedByRunnerAt,
    fullyConfirmed: row.confirmedByRequesterAt !== null && row.confirmedByRunnerAt !== null,
  };
}

/**
 * The payment agreement (Backend PRD 16.1): a record of what the two parties say they agreed. It
 * never means Urgent.ng received money and nothing here processes a payment (INV-008).
 *
 * Rules:
 *  - only the two parties, and only while the assignment is ACCEPTED;
 *  - the amount is not writable here, it changes only through an accepted change request;
 *  - changing the method or timing clears both confirmations (a confirmation covers the terms as
 *    they were), after which `confirm` confirms for the caller;
 *  - confirming needs both a method and a timing.
 */
@Injectable()
export class PaymentAgreementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async get(userId: string, assignmentId: string): Promise<PaymentAgreementDto> {
    await this.partyOf(this.prisma, userId, assignmentId);
    const row = await this.prisma.paymentAgreement.findFirst({ where: { assignmentId } });
    if (!row) {
      // A pending, declined or timed-out assignment has no agreement yet.
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return toPaymentAgreementDto(row);
  }

  async update(userId: string, assignmentId: string, input: UpdatePaymentAgreementDto): Promise<PaymentAgreementDto> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const { role, assignment } = await this.partyOf(tx, userId, assignmentId);
      if (assignment.status !== 'ACCEPTED') {
        throw DomainException.of(ASSIGNMENT_INVALID_STATE, {
          message: 'The payment agreement can only be changed while the assignment is active.',
          details: { status: assignment.status },
        });
      }
      const locked = await tx.$queryRaw<Array<{ assignment_id: string }>>`
        SELECT assignment_id::text FROM payment_agreements
        WHERE assignment_id = ${assignmentId}::uuid AND deleted_at IS NULL FOR UPDATE
      `;
      const current = locked[0] ? await tx.paymentAgreement.findFirst({ where: { assignmentId } }) : null;
      if (!current) {
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }

      const method = input.paymentMethod ?? current.paymentMethod;
      const timing = input.paymentTiming ?? current.paymentTiming;
      const changed = method !== current.paymentMethod || timing !== current.paymentTiming;
      if (input.confirm && (!method || !timing)) {
        throw DomainException.of(VALIDATION_ERROR, {
          message: 'Choose how and when payment will be made before confirming.',
          details: { field: 'confirm', missing: [!method && 'paymentMethod', !timing && 'paymentTiming'].filter(Boolean) },
        });
      }
      if (!changed && !input.confirm) {
        return current;
      }

      const now = await this.dbNow(tx);
      const keepRequester = changed ? null : current.confirmedByRequesterAt;
      const keepRunner = changed ? null : current.confirmedByRunnerAt;
      const row = await tx.paymentAgreement.update({
        where: { assignmentId },
        data: {
          paymentMethod: method,
          paymentTiming: timing,
          confirmedByRequesterAt: input.confirm && role === 'REQUESTER' ? now : keepRequester,
          confirmedByRunnerAt: input.confirm && role === 'RUNNER' ? now : keepRunner,
        },
      });

      await this.outbox.add(tx, {
        eventType: 'payment_agreement.updated',
        aggregateType: 'assignment',
        aggregateId: assignmentId,
        payload: {
          assignmentId,
          errandId: assignment.errandId,
          requesterId: assignment.requesterId,
          runnerId: assignment.runnerId,
          actorRole: role,
          termsChanged: changed,
          confirmationsCleared: changed && (current.confirmedByRequesterAt !== null || current.confirmedByRunnerAt !== null),
          fullyConfirmed: row.confirmedByRequesterAt !== null && row.confirmedByRunnerAt !== null,
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'payment_agreement.updated',
        entityType: 'assignment',
        entityId: assignmentId,
        metadata: { errandId: assignment.errandId, termsChanged: changed, confirmed: input.confirm === true, role },
      });
      return row;
    });
    return toPaymentAgreementDto(updated);
  }

  private async partyOf(
    client: Pick<Prisma.TransactionClient, 'assignment'>,
    userId: string,
    assignmentId: string,
  ): Promise<{ role: 'REQUESTER' | 'RUNNER'; assignment: { status: string; errandId: string; requesterId: string; runnerId: string } }> {
    const assignment = await client.assignment.findFirst({
      where: { id: assignmentId, OR: [{ requesterId: userId }, { runnerId: userId }] },
      select: { status: true, errandId: true, requesterId: true, runnerId: true },
    });
    if (!assignment) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return { role: assignment.requesterId === userId ? 'REQUESTER' : 'RUNNER', assignment };
  }

  private async dbNow(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return rows[0].now;
  }
}

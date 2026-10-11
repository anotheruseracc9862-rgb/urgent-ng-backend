import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditActorType, type Prisma, type Refund } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { PAYMENT_PROVIDER, type IPaymentProvider } from '../common/providers/payment.provider.js';
import { ERRAND_INVALID_STATE, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { refundNeedsFourEyes } from './billing.rules.js';

export interface RefundActor {
  type: AuditActorType;
  id?: string;
}

export interface RequestRefundInput {
  paymentId: string;
  /** Omit to refund what is left of the payment. */
  amountMinor?: number;
  reason: string;
  actor: RefundActor;
}

const DONE = ['REQUESTED', 'APPROVED', 'PROCESSING', 'COMPLETED'] as const;

/**
 * Refunds (Backend PRD 22.6). Every refund is a row with its reason, actor and amount; a completed
 * one is immutable (a database trigger refuses any change). The gateway is told exactly once.
 *
 * Who may refund: the system, automatically, for a boost that could not run and a verification fee
 * that failed through no fault of the runner; and an admin, for anything else. A refund at or above
 * `REFUND_FOUR_EYES_THRESHOLD` waits for a second admin (`approve`) before the gateway is called.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: BusinessConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly gateway: IPaymentProvider,
  ) {}

  /** A refund the system owes (a boost that could not start, a provider fault). No approval step. */
  async requestAutomatic(input: { paymentId: string; reason: string }): Promise<Refund | null> {
    const payment = await this.prisma.payment.findUnique({ where: { id: input.paymentId } });
    if (!payment) return null;
    // One automatic refund per payment and cause, however many times the trigger fires.
    const prior = await this.prisma.refund.findFirst({
      where: { paymentId: input.paymentId, reason: input.reason, status: { in: [...DONE] } },
    });
    if (prior) return prior;
    const refund = await this.create({ ...input, actor: { type: AuditActorType.SYSTEM } }, payment.amountMinor, true);
    return this.execute(refund.id);
  }

  /** An admin asks for a refund (the controller and its four-eyes wrapper arrive with P11). */
  async request(input: RequestRefundInput): Promise<Refund> {
    const payment = await this.prisma.payment.findUnique({ where: { id: input.paymentId } });
    if (!payment) throw DomainException.of(RESOURCE_NOT_FOUND);
    const refund = await this.create(input, payment.amountMinor, false);
    const threshold = await this.config.get('REFUND_FOUR_EYES_THRESHOLD');
    if (refundNeedsFourEyes(Number(refund.amountMinor), threshold)) {
      return refund; // waits in REQUESTED for a second admin
    }
    return this.execute(refund.id);
  }

  /** The second admin approves a refund that needed it, and it is executed. The requester cannot approve their own. */
  async approve(refundId: string, approver: { adminId: string }): Promise<Refund> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund) throw DomainException.of(RESOURCE_NOT_FOUND);
    if (refund.status !== 'REQUESTED') {
      throw DomainException.of(ERRAND_INVALID_STATE, { message: 'This refund is not waiting for approval.', details: { status: refund.status } });
    }
    if (refund.requestedById === approver.adminId) {
      throw DomainException.of(ERRAND_INVALID_STATE, { message: 'A refund needs a second admin to approve it.', details: { reason: 'SAME_ADMIN' } });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.refund.update({ where: { id: refundId }, data: { status: 'APPROVED', approvedBy: approver.adminId } });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: approver.adminId,
        action: 'refund.approved',
        entityType: 'refund',
        entityId: refundId,
        metadata: { paymentId: refund.paymentId, amountMinor: Number(refund.amountMinor) },
      });
    });
    return this.execute(refundId);
  }

  async reject(refundId: string, reason: string, admin: { adminId: string }): Promise<Refund> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund) throw DomainException.of(RESOURCE_NOT_FOUND);
    if (refund.status !== 'REQUESTED') {
      throw DomainException.of(ERRAND_INVALID_STATE, { message: 'This refund is not waiting for approval.', details: { status: refund.status } });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.refund.update({ where: { id: refundId }, data: { status: 'REJECTED', failureReason: reason.trim() || 'Rejected', approvedBy: admin.adminId } });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: admin.adminId,
        action: 'refund.rejected',
        entityType: 'refund',
        entityId: refundId,
        reasonCode: reason,
      });
      return updated;
    });
  }

  /**
   * Tell the gateway, once, and record the answer. Only REQUESTED (automatic or small) and APPROVED
   * refunds run. A gateway that answers "pending" leaves the refund PROCESSING for its webhook.
   */
  async execute(refundId: string): Promise<Refund> {
    const claimed = await this.prisma.$queryRaw<Array<{ id: string; payment_id: string; amount_minor: bigint }>>`
      UPDATE refunds SET status = 'PROCESSING'::"RefundStatus", updated_at = clock_timestamp()
      WHERE id = ${refundId}::uuid AND status IN ('REQUESTED'::"RefundStatus", 'APPROVED'::"RefundStatus")
      RETURNING id::text, payment_id::text, amount_minor
    `;
    if (!claimed[0]) {
      return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    }
    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: claimed[0].payment_id } });

    let providerRef: string;
    let state: 'processed' | 'pending' | 'failed';
    try {
      const result = await this.gateway.refund({ reference: payment.providerReference, amountKobo: Number(claimed[0].amount_minor) });
      providerRef = result.providerRefundRef;
      state = result.status;
    } catch (error) {
      this.logger.error(`Refund ${refundId} failed at the gateway: ${error instanceof Error ? error.message : String(error)}`);
      await this.prisma.paymentAttempt.create({ data: { paymentId: payment.id, kind: 'REFUND', status: 'failed', providerResponse: { refundId } } });
      return this.finish(refundId, 'FAILED', { failureReason: 'GATEWAY_ERROR' });
    }
    await this.prisma.paymentAttempt.create({
      data: { paymentId: payment.id, kind: 'REFUND', status: state, providerResponse: { refundId, providerRefundRef: providerRef } },
    });
    if (state === 'failed') return this.finish(refundId, 'FAILED', { providerRefundRef: providerRef, failureReason: 'GATEWAY_REJECTED' });
    if (state === 'pending') {
      await this.prisma.refund.update({ where: { id: refundId }, data: { providerRefundRef: providerRef } });
      return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    }
    return this.finish(refundId, 'COMPLETED', { providerRefundRef: providerRef });
  }

  /** The gateway's later word on a refund that was pending (a `refund.processed` or `refund.failed` event). */
  async onProviderEvent(providerRefundRef: string, outcome: 'processed' | 'failed'): Promise<Refund | null> {
    const refund = await this.prisma.refund.findFirst({ where: { providerRefundRef } });
    if (!refund || refund.status !== 'PROCESSING') return refund;
    return this.finish(refund.id, outcome === 'processed' ? 'COMPLETED' : 'FAILED', {
      providerRefundRef,
      failureReason: outcome === 'failed' ? 'GATEWAY_REJECTED' : undefined,
    });
  }

  // ---- Internals ----

  private async create(input: RequestRefundInput, paid: bigint, automatic: boolean): Promise<Refund> {
    const reason = input.reason.trim();
    if (!reason) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'A refund needs a reason.', details: { field: 'reason' } });
    }
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status::text AS status FROM payments WHERE id = ${input.paymentId}::uuid FOR UPDATE
      `;
      if (!locked[0] || !['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(locked[0].status)) {
        throw DomainException.of(ERRAND_INVALID_STATE, { message: 'Only a paid payment can be refunded.', details: { status: locked[0]?.status ?? null } });
      }
      const taken = await tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT COALESCE(SUM(amount_minor), 0)::bigint AS total FROM refunds
        WHERE payment_id = ${input.paymentId}::uuid AND status IN ('REQUESTED'::"RefundStatus", 'APPROVED'::"RefundStatus",
                                                                  'PROCESSING'::"RefundStatus", 'COMPLETED'::"RefundStatus")
      `;
      const remaining = Number(paid) - Number(taken[0].total);
      const amount = input.amountMinor ?? remaining;
      if (amount <= 0 || amount > remaining) {
        throw DomainException.of(VALIDATION_ERROR, {
          message: 'That is more than is left to refund.',
          details: { field: 'amountMinor', remainingMinor: remaining },
        });
      }
      const refund = await tx.refund.create({
        data: {
          paymentId: input.paymentId,
          amountMinor: BigInt(amount),
          reason,
          requestedByType: input.actor.type,
          requestedById: input.actor.id ?? null,
          status: 'REQUESTED',
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'refund.requested',
        entityType: 'refund',
        entityId: refund.id,
        metadata: { paymentId: input.paymentId, amountMinor: amount, automatic },
      });
      return refund;
    });
  }

  /** Close a refund and carry its consequences: the payment and order status, and what the purchase granted. */
  private async finish(
    refundId: string,
    status: 'COMPLETED' | 'FAILED',
    extra: { providerRefundRef?: string; failureReason?: string },
  ): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      const refund = await tx.refund.update({
        where: { id: refundId },
        data: { status, providerRefundRef: extra.providerRefundRef, failureReason: extra.failureReason ?? null },
      });
      if (status === 'COMPLETED') {
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
        const refunded = await tx.$queryRaw<Array<{ total: bigint }>>`
          SELECT COALESCE(SUM(amount_minor), 0)::bigint AS total FROM refunds WHERE payment_id = ${payment.id}::uuid AND status = 'COMPLETED'::"RefundStatus"
        `;
        const full = refunded[0].total >= payment.amountMinor;
        const orderUserId = (await tx.order.findUniqueOrThrow({ where: { id: payment.orderId }, select: { userId: true } })).userId;
        await tx.$executeRaw`
          UPDATE payments SET status = ${full ? 'REFUNDED' : 'PARTIALLY_REFUNDED'}::"PaymentStatus", updated_at = clock_timestamp()
          WHERE id = ${payment.id}::uuid
        `;
        if (full) {
          const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });
          await tx.$executeRaw`UPDATE orders SET status = 'REFUNDED'::"OrderStatus", updated_at = clock_timestamp() WHERE id = ${order.id}::uuid`;
          await this.undoGrant(tx, order.type, order.id, order.userId);
        }
        await this.outbox.add(tx, {
          eventType: 'refund.completed',
          aggregateType: 'order',
          aggregateId: payment.orderId,
          payload: { refundId, paymentId: payment.id, orderId: payment.orderId, userId: orderUserId, amountMinor: Number(refund.amountMinor), full },
        });
      }
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.SYSTEM,
        action: status === 'COMPLETED' ? 'refund.completed' : 'refund.failed',
        entityType: 'refund',
        entityId: refundId,
        reasonCode: extra.failureReason,
        metadata: { paymentId: refund.paymentId, amountMinor: Number(refund.amountMinor) },
      });
      return refund;
    });
  }

  /** A fully refunded purchase stops granting what it granted. */
  private async undoGrant(
    tx: Prisma.TransactionClient,
    type: 'RUNNER_PRO' | 'BOOST' | 'VERIFICATION_FEE',
    orderId: string,
    userId: string,
  ): Promise<void> {
    if (type === 'BOOST') {
      await tx.$executeRaw`
        UPDATE boosts SET status = 'REFUNDED'::"BoostStatus", ended_reason = 'REFUNDED', updated_at = clock_timestamp()
        WHERE order_id = ${orderId}::uuid AND status IN ('PURCHASED'::"BoostStatus", 'SCHEDULED'::"BoostStatus", 'ACTIVE'::"BoostStatus", 'CANCELLED'::"BoostStatus")
      `;
      return;
    }
    if (type === 'VERIFICATION_FEE') {
      await tx.$executeRaw`
        UPDATE entitlements SET revoked_at = clock_timestamp()
        WHERE source = 'ORDER' AND source_id = ${orderId}::uuid AND type = 'VERIFICATION_ATTEMPT_ALLOWANCE'::"EntitlementType" AND revoked_at IS NULL
      `;
      return;
    }
    // Runner Pro: the period this order paid for ends now.
    await tx.$executeRaw`
      UPDATE entitlements SET revoked_at = clock_timestamp()
      WHERE type = 'RUNNER_PRO'::"EntitlementType" AND user_id = ${userId}::uuid AND revoked_at IS NULL
        AND source = 'SUBSCRIPTION'
        AND source_id IN (SELECT id FROM subscriptions WHERE latest_order_id = ${orderId}::uuid)
        AND valid_until > clock_timestamp()
    `;
  }
}

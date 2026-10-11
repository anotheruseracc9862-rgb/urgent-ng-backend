import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { EventDispatcher, type DomainEvent, type DomainEventHandler } from '../queue/event-dispatcher.js';
import { RefundService } from './refund.service.js';

const PROVIDER_FAULTS = ['PROVIDER_ERROR', 'PROVIDER_TIMEOUT'];

/**
 * A verification fee is returned when the runner never got a fair try (Backend PRD 10.2, 22.6):
 * every attempt since they paid ended in a provider fault, which never counts against them, and
 * they are still not verified. After `VERIFICATION_REFUND_AFTER_PROVIDER_FAULTS` such faults the
 * fee is refunded automatically, once. A runner who failed on their own account is not refunded.
 */
@Injectable()
export class VerificationFeeRefundHandler implements DomainEventHandler, OnModuleInit {
  readonly name = 'VerificationFeeRefundHandler';

  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly refunds: RefundService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: DomainEvent): Promise<void> {
    if (event.eventType !== 'verification.failed') return;
    const userId = event.payload.userId;
    const reason = event.payload.failureReason;
    if (typeof userId !== 'string' || typeof reason !== 'string' || !PROVIDER_FAULTS.includes(reason)) return;

    const threshold = await this.config.get('VERIFICATION_REFUND_AFTER_PROVIDER_FAULTS');
    // The newest fee the user paid and its first payment, with what has happened since.
    const rows = await this.prisma.$queryRaw<Array<{ payment_id: string; faults: number; counted: number; verified: boolean }>>`
      WITH fee AS (
        SELECT e.source_id AS order_id, e.valid_from
        FROM entitlements e
        WHERE e.user_id = ${userId}::uuid AND e.type = 'VERIFICATION_ATTEMPT_ALLOWANCE'::"EntitlementType"
          AND e.source = 'ORDER' AND e.revoked_at IS NULL
        ORDER BY e.valid_from DESC LIMIT 1
      )
      SELECT p.id::text AS payment_id,
             (SELECT count(*)::int FROM verification_attempts a
                WHERE a.user_id = ${userId}::uuid AND a.started_at >= fee.valid_from AND a.status = 'FAILED'::"VerificationStatus"
                  AND a.failure_reason IN ('PROVIDER_ERROR'::"VerificationFailureReason", 'PROVIDER_TIMEOUT'::"VerificationFailureReason")) AS faults,
             (SELECT count(*)::int FROM verification_attempts a
                WHERE a.user_id = ${userId}::uuid AND a.started_at >= fee.valid_from AND a.counts_against_allowance
                  AND a.status IN ('FAILED'::"VerificationStatus", 'VERIFIED'::"VerificationStatus")) AS counted,
             EXISTS (SELECT 1 FROM verification_attempts a WHERE a.user_id = ${userId}::uuid AND a.status = 'VERIFIED'::"VerificationStatus"
                       AND a.deleted_at IS NULL) AS verified
      FROM fee
      JOIN payments p ON p.order_id = fee.order_id AND p.status = 'SUCCEEDED'::"PaymentStatus"
      ORDER BY p.paid_at DESC LIMIT 1
    `;
    const row = rows[0];
    if (!row || row.verified || row.counted > 0 || row.faults < threshold) return;
    await this.refunds.requestAutomatic({ paymentId: row.payment_id, reason: 'AUTO:PROVIDER_FAULT' });
  }
}

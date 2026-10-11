import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditActorType, type Order, type Payment } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { PAYMENT_PROVIDER, type IPaymentProvider } from '../common/providers/payment.provider.js';
import { encrypt } from '../common/utils/crypto.helper.js';
import { BoostService } from '../boosts/boost.service.js';
import { ProSubscriptionService } from '../subscriptions/pro-subscription.service.js';
import { RiskFlagService } from '../risk/risk-flag.service.js';
import { RefundService } from './refund.service.js';
import { vatPortion } from './billing.rules.js';

export type SettleOutcome =
  | { result: 'SETTLED'; orderId: string; type: Order['type'] }
  | { result: 'ALREADY_SETTLED'; orderId: string }
  | { result: 'PENDING'; orderId: string }
  | { result: 'FAILED'; orderId: string }
  | { result: 'MISMATCH'; orderId: string }
  | { result: 'UNKNOWN_REFERENCE' };

/**
 * Turns a gateway payment into what the customer bought (Backend PRD 22.2). The only trusted
 * source is the gateway's own answer to `verifyTransaction`: a webhook, a browser return or a
 * "check my payment" call all end here, and none of them is believed by itself.
 *
 * Settlement is idempotent. The payment row is locked, and only an INITIATED payment is settled,
 * so a duplicate webhook, a retried verify and a reconciliation run all converge on one grant.
 * The grant and the status change are one transaction.
 */
@Injectable()
export class PaymentSettlementService {
  private readonly logger = new Logger(PaymentSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: BusinessConfigService,
    private readonly appConfig: ConfigService,
    private readonly notifications: NotificationService,
    private readonly boosts: BoostService,
    private readonly pro: ProSubscriptionService,
    private readonly refunds: RefundService,
    private readonly risk: RiskFlagService,
    @Inject(PAYMENT_PROVIDER) private readonly gateway: IPaymentProvider,
  ) {}

  /** Settle the payment with this gateway reference, asking the gateway what really happened. */
  async settle(reference: string, source: 'WEBHOOK' | 'VERIFY' | 'RECONCILIATION'): Promise<SettleOutcome> {
    const payment = await this.prisma.payment.findFirst({ where: { providerReference: reference } });
    if (!payment) return { result: 'UNKNOWN_REFERENCE' };
    if (payment.status !== 'INITIATED') return { result: 'ALREADY_SETTLED', orderId: payment.orderId };

    // The gateway is asked outside any transaction: a slow answer must not hold a lock.
    const verified = await this.gateway.verifyTransaction(reference);
    await this.prisma.paymentAttempt.create({
      data: {
        paymentId: payment.id,
        kind: 'VERIFY',
        status: verified.status,
        providerResponse: { source, amountKobo: verified.amountKobo },
      },
    });

    if (verified.status === 'pending' || verified.status === 'abandoned') {
      return { result: 'PENDING', orderId: payment.orderId };
    }
    if (verified.status === 'failed') {
      await this.fail(payment, 'GATEWAY_FAILED');
      return { result: 'FAILED', orderId: payment.orderId };
    }
    if (BigInt(verified.amountKobo) !== payment.amountMinor) {
      // Money arrived, but not the amount we asked for. Never grant on it; an admin looks.
      await this.fail(payment, 'AMOUNT_MISMATCH');
      await this.risk.raiseQuietly({
        signal: 'PAYMENT_ANOMALY',
        details: { reason: 'AMOUNT_MISMATCH', paymentId: payment.id, expectedKobo: Number(payment.amountMinor), receivedKobo: verified.amountKobo },
      });
      return { result: 'MISMATCH', orderId: payment.orderId };
    }

    const maxHours = await this.boosts.maxHours();
    const proDays = await this.config.get('RUNNER_PRO_PERIOD_DAYS');
    const allowance = await this.config.get('VERIFICATION_ATTEMPTS_PER_FEE');
    const vatRate = await this.config.get('VAT_RATE');

    const done = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id::text, status::text AS status FROM payments WHERE id = ${payment.id}::uuid FOR UPDATE
      `;
      if (locked[0]?.status !== 'INITIATED') return null; // another settlement won the race
      const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });

      const authorization = verified.authorizationCode ? this.sealAuthorization(verified.authorizationCode, payment.id) : null;
      await tx.$executeRaw`
        UPDATE payments
        SET status = 'SUCCEEDED'::"PaymentStatus", paid_at = COALESCE(${verified.paidAt ?? null}::timestamptz, clock_timestamp()),
            authorization_code = COALESCE(${authorization}, authorization_code), authorization_url = NULL,
            updated_at = clock_timestamp()
        WHERE id = ${payment.id}::uuid
      `;
      await tx.$executeRaw`
        UPDATE orders SET status = 'PAID'::"OrderStatus", paid_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${order.id}::uuid
      `;

      let boostNotActivated = false;
      switch (order.type) {
        case 'RUNNER_PRO': {
          const meta = (order.metadata ?? {}) as { autoRenew?: boolean };
          await this.pro.applyPayment(tx, { userId: order.userId, orderId: order.id, autoRenew: meta.autoRenew ?? null, days: proDays });
          break;
        }
        case 'BOOST': {
          const outcome = await this.boosts.activate(tx, {
            orderId: order.id,
            errandId: order.targetErrandId as string,
            userId: order.userId,
            maxHours,
          });
          boostNotActivated = !outcome.activated;
          break;
        }
        case 'VERIFICATION_FEE': {
          await tx.$executeRaw`
            INSERT INTO entitlements (user_id, type, source, source_id, quantity, valid_from)
            VALUES (${order.userId}::uuid, 'VERIFICATION_ATTEMPT_ALLOWANCE'::"EntitlementType", 'ORDER', ${order.id}::uuid,
                    ${allowance}::int, clock_timestamp())
            ON CONFLICT ("source", "source_id", "type", "valid_from") WHERE "source_id" IS NOT NULL DO NOTHING
          `;
          break;
        }
      }

      await this.outbox.add(tx, {
        eventType: 'order.paid',
        aggregateType: 'order',
        aggregateId: order.id,
        payload: {
          orderId: order.id,
          userId: order.userId,
          type: order.type,
          amountMinor: Number(order.amountMinor),
          vatMinor: vatPortion(Number(order.amountMinor), vatRate),
          reference,
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.SYSTEM,
        action: 'order.paid',
        entityType: 'order',
        entityId: order.id,
        metadata: { userId: order.userId, type: order.type, amountMinor: Number(order.amountMinor), source },
      });
      return { order, boostNotActivated };
    });

    if (!done) {
      return { result: 'ALREADY_SETTLED', orderId: payment.orderId };
    }
    if (done.boostNotActivated) {
      // The errand left OPEN before the money arrived: the boost cannot run, so the money goes back.
      await this.refunds.requestAutomatic({ paymentId: payment.id, reason: 'AUTO:BOOST_NOT_ACTIVATED' });
    } else {
      await this.sendReceipt(done.order, reference, vatRate);
    }
    return { result: 'SETTLED', orderId: done.order.id, type: done.order.type };
  }

  // ---- Internals ----

  private async fail(payment: Payment, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`
        UPDATE payments SET status = 'FAILED'::"PaymentStatus", updated_at = clock_timestamp()
        WHERE id = ${payment.id}::uuid AND status = 'INITIATED'::"PaymentStatus"
      `;
      if (changed === 0) return;
      await tx.$executeRaw`
        UPDATE orders SET status = 'FAILED'::"OrderStatus", updated_at = clock_timestamp()
        WHERE id = ${payment.orderId}::uuid AND status = 'PENDING'::"OrderStatus"
      `;
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.SYSTEM,
        action: 'payment.failed',
        entityType: 'payment',
        entityId: payment.id,
        reasonCode: reason,
        metadata: { orderId: payment.orderId },
      });
    });
  }

  /** The saved card authorisation is stored encrypted and bound to its payment row. */
  private sealAuthorization(code: string, paymentId: string): string {
    return encrypt(code, this.appConfig.getOrThrow<string>('security.dataEncryptionKey'), { aad: `payment:${paymentId}` });
  }

  private async sendReceipt(order: Order, reference: string, vatRate: number): Promise<void> {
    try {
      const amount = Number(order.amountMinor);
      const labels: Record<string, string> = { RUNNER_PRO: 'Runner Pro', BOOST: 'Priority Boost', VERIFICATION_FEE: 'Runner verification' };
      const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      await this.notifications.notify({
        userId: order.userId,
        template: 'billing.receipt',
        vars: { product: labels[order.type] ?? 'Urgent.ng', amount: naira(amount), vat: naira(vatPortion(amount, vatRate)), reference },
        data: { orderId: order.id },
        dedupeKey: `order:${order.id}:receipt`,
      });
    } catch (error) {
      // A receipt that cannot be sent never undoes a payment that went through.
      this.logger.warn(`Receipt for order ${order.id} not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}


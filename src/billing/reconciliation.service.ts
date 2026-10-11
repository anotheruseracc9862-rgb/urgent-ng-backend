import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { PAYMENT_PROVIDER, type IPaymentProvider } from '../common/providers/payment.provider.js';
import { RiskFlagService } from '../risk/risk-flag.service.js';
import { PaymentSettlementService } from './payment-settlement.service.js';

export interface ReconciliationReport {
  checked: number;
  /** A payment the gateway had settled but we had not (a missed webhook), now settled. */
  recovered: number;
  /** Checkouts that were never paid and are now closed. */
  closed: number;
  /** Anything that needs a human: raised as a PAYMENT_ANOMALY risk flag. */
  anomalies: number;
}

/**
 * Daily reconciliation against the gateway (Backend PRD 22.2). Webhooks can be lost; this finds
 * what they missed and what does not add up, and never trusts our own rows over the gateway's.
 *
 *  - INITIATED older than `staleMinutes`: ask the gateway. Paid -> settle it. Failed -> close it.
 *    Still unpaid after a day -> close it as abandoned.
 *  - SUCCEEDED in the last two days: ask again. If the gateway does not agree (not successful, or
 *    another amount), raise an anomaly. We change nothing on our side without an admin.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settlement: PaymentSettlementService,
    private readonly risk: RiskFlagService,
    @Inject(PAYMENT_PROVIDER) private readonly gateway: IPaymentProvider,
  ) {}

  async run(options: { staleMinutes?: number } = {}): Promise<ReconciliationReport> {
    const staleMinutes = options.staleMinutes ?? 15;
    const report: ReconciliationReport = { checked: 0, recovered: 0, closed: 0, anomalies: 0 };

    const open = await this.prisma.$queryRaw<Array<{ id: string; provider_reference: string; abandoned: boolean }>>`
      SELECT id::text, provider_reference, (created_at < clock_timestamp() - interval '24 hours') AS abandoned
      FROM payments
      WHERE status = 'INITIATED'::"PaymentStatus" AND created_at < clock_timestamp() - make_interval(mins => ${staleMinutes}::int)
      ORDER BY created_at LIMIT 500
    `;
    for (const payment of open) {
      report.checked += 1;
      try {
        const outcome = await this.settlement.settle(payment.provider_reference, 'RECONCILIATION');
        if (outcome.result === 'SETTLED') report.recovered += 1;
        else if (outcome.result === 'FAILED') report.closed += 1;
        else if (outcome.result === 'MISMATCH') report.anomalies += 1;
        else if (outcome.result === 'PENDING' && payment.abandoned) {
          report.closed += await this.closeAbandoned(payment.id);
        }
      } catch (error) {
        this.logger.warn(`Reconciliation could not check ${payment.provider_reference}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const paid = await this.prisma.$queryRaw<Array<{ id: string; provider_reference: string; amount_minor: bigint }>>`
      SELECT id::text, provider_reference, amount_minor FROM payments
      WHERE status IN ('SUCCEEDED'::"PaymentStatus", 'PARTIALLY_REFUNDED'::"PaymentStatus")
        AND paid_at > clock_timestamp() - interval '2 days'
      ORDER BY paid_at DESC LIMIT 500
    `;
    for (const payment of paid) {
      report.checked += 1;
      try {
        const verified = await this.gateway.verifyTransaction(payment.provider_reference);
        if (verified.status !== 'success' || BigInt(verified.amountKobo) !== payment.amount_minor) {
          report.anomalies += 1;
          await this.risk.raiseQuietly({
            signal: 'PAYMENT_ANOMALY',
            details: {
              reason: verified.status !== 'success' ? 'PAID_HERE_NOT_AT_GATEWAY' : 'AMOUNT_DIFFERS_AT_GATEWAY',
              paymentId: payment.id,
              gatewayStatus: verified.status,
              expectedKobo: Number(payment.amount_minor),
              gatewayKobo: verified.amountKobo,
            },
          });
        }
      } catch (error) {
        this.logger.warn(`Reconciliation could not re-check ${payment.provider_reference}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return report;
  }

  /** A checkout nobody paid in a day: close the payment and cancel its order. */
  private async closeAbandoned(paymentId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`
        UPDATE payments SET status = 'FAILED'::"PaymentStatus", updated_at = clock_timestamp()
        WHERE id = ${paymentId}::uuid AND status = 'INITIATED'::"PaymentStatus"
      `;
      if (changed === 0) return 0;
      await tx.$executeRaw`
        UPDATE orders SET status = 'CANCELLED'::"OrderStatus", updated_at = clock_timestamp()
        WHERE id = (SELECT order_id FROM payments WHERE id = ${paymentId}::uuid) AND status = 'PENDING'::"OrderStatus"
      `;
      return 1;
    });
  }
}

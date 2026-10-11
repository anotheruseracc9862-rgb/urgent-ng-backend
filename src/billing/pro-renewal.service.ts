import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service.js';
import { PAYMENT_PROVIDER, type IPaymentProvider } from '../common/providers/payment.provider.js';
import { decrypt } from '../common/utils/crypto.helper.js';
import { ProSubscriptionService } from '../subscriptions/pro-subscription.service.js';
import { OrderService } from './order.service.js';
import { PaymentSettlementService } from './payment-settlement.service.js';

/**
 * Runner Pro auto-renewal (Backend PRD 22.4). When a paid period ends and the runner has
 * auto-renew on, the card authorisation saved with their last payment is charged. A failure moves
 * the subscription into its grace days (benefits continue) and the charge is tried again each day
 * until the grace ends; a runner can always pay by hand instead.
 *
 * Money is never taken on a guess: a renewal is an order and a payment like any other, and the
 * gateway's own answer is verified before the new period is granted.
 */
@Injectable()
export class ProRenewalService {
  private readonly logger = new Logger(ProRenewalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: ConfigService,
    private readonly orders: OrderService,
    private readonly settlement: PaymentSettlementService,
    private readonly pro: ProSubscriptionService,
    @Inject(PAYMENT_PROVIDER) private readonly gateway: IPaymentProvider,
  ) {}

  /** Try every renewal that is due. Returns how many charges were attempted. */
  async renewDue(batch = 25): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string; user_id: string; status: string; current_period_end: Date; day: string }>>`
      SELECT id::text, user_id::text, status::text AS status, current_period_end, to_char(clock_timestamp(), 'YYYY-MM-DD') AS day
      FROM subscriptions
      WHERE auto_renew = TRUE AND (
        (status = 'ACTIVE'::"SubscriptionStatus" AND current_period_end <= clock_timestamp())
        OR (status = 'GRACE_PERIOD'::"SubscriptionStatus" AND grace_ends_at > clock_timestamp()
            AND (renewal_attempted_at IS NULL OR renewal_attempted_at <= clock_timestamp() - interval '24 hours'))
      )
      ORDER BY current_period_end
      LIMIT ${batch}
    `;
    let attempted = 0;
    for (const sub of due) {
      try {
        if (await this.renewOne(sub)) attempted += 1;
      } catch (error) {
        this.logger.error(`Renewal of subscription ${sub.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return attempted;
  }

  private async renewOne(sub: { id: string; user_id: string; status: string; current_period_end: Date; day: string }): Promise<boolean> {
    // One charge per subscription, period and day, whatever runs this twice.
    const key = `renewal:${sub.id}:${sub.current_period_end.toISOString()}:${sub.day}`;
    const claimed = await this.prisma.$executeRaw`
      UPDATE subscriptions
      SET renewal_attempted_at = clock_timestamp(),
          status = CASE WHEN status = 'ACTIVE'::"SubscriptionStatus" THEN 'PENDING_RENEWAL'::"SubscriptionStatus" ELSE status END,
          updated_at = clock_timestamp()
      WHERE id = ${sub.id}::uuid AND auto_renew = TRUE
        AND status IN ('ACTIVE'::"SubscriptionStatus", 'GRACE_PERIOD'::"SubscriptionStatus")
        AND (renewal_attempted_at IS NULL OR renewal_attempted_at <= clock_timestamp() - interval '23 hours'
             OR status = 'ACTIVE'::"SubscriptionStatus")
    `;
    if (claimed === 0) return false;

    const authorization = await this.savedAuthorization(sub.user_id);
    if (!authorization) {
      await this.failRenewal(sub.id, 'NO_AUTHORIZATION');
      return true;
    }
    const order = await this.orders.createRenewal(sub.user_id, key);
    let charge;
    try {
      charge = await this.gateway.chargeAuthorization({
        email: order.email,
        authorizationCode: authorization,
        amountKobo: order.amountKobo,
        reference: order.reference,
      });
    } catch (error) {
      await this.prisma.paymentAttempt.create({ data: { paymentId: order.paymentId, kind: 'CHARGE_AUTHORIZATION', status: 'error' } });
      await this.failRenewal(sub.id, 'GATEWAY_ERROR');
      this.logger.warn(`Renewal charge error: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
    await this.prisma.paymentAttempt.create({
      data: { paymentId: order.paymentId, kind: 'CHARGE_AUTHORIZATION', status: charge.status, providerResponse: { amountKobo: charge.amountKobo } },
    });
    if (charge.status !== 'success') {
      await this.failRenewal(sub.id, 'DECLINED');
      return true;
    }
    // Believe the gateway's verify, not the charge reply alone: settlement asks again.
    const outcome = await this.settlement.settle(order.reference, 'VERIFY');
    if (outcome.result !== 'SETTLED' && outcome.result !== 'ALREADY_SETTLED') {
      await this.failRenewal(sub.id, 'NOT_CONFIRMED');
    }
    return true;
  }

  private async failRenewal(subscriptionId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.pro.markRenewalFailed(tx, subscriptionId, reason);
    });
  }

  /** The newest reusable authorisation from a successful Runner Pro payment of this user. */
  private async savedAuthorization(userId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; authorization_code: string }>>`
      SELECT p.id::text, p.authorization_code
      FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE o.user_id = ${userId}::uuid AND o.type = 'RUNNER_PRO'::"OrderType" AND p.status IN ('SUCCEEDED'::"PaymentStatus", 'PARTIALLY_REFUNDED'::"PaymentStatus")
        AND p.authorization_code IS NOT NULL
      ORDER BY p.paid_at DESC NULLS LAST
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    try {
      return decrypt(row.authorization_code, this.appConfig.getOrThrow<string>('security.dataEncryptionKey'), { aad: `payment:${row.id}` });
    } catch {
      this.logger.error(`Saved authorisation of payment ${row.id} cannot be read`);
      return null;
    }
  }
}

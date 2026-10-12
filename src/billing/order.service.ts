import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditActorType, Prisma, type Order, type OrderType, type Payment } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { PricingService } from '../config/pricing.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { PAYMENT_PROVIDER, type IPaymentProvider } from '../common/providers/payment.provider.js';
import { ProviderError } from '../common/providers/provider.error.js';
import { PAYMENT_PROVIDER_UNAVAILABLE, RESOURCE_CONFLICT, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { BoostService } from '../boosts/boost.service.js';
import { VerificationStatusService } from '../verification/verification-status.service.js';
import { gatewayEmail, paymentReference, PRODUCT_CODE_BY_ORDER_TYPE, vatPortion } from './billing.rules.js';
import type { OrderDto, OrderListQueryDto, ProductDto } from './billing.dto.js';

export const PAYMENT_PROVIDER_NAME = 'paystack';

export interface CreateOrderInput {
  type: OrderType;
  errandId?: string;
  autoRenew?: boolean;
}

export function toOrderDto(order: Order, payment: Payment | null, vatRate: number): OrderDto {
  const amount = Number(order.amountMinor);
  const open = payment !== null && payment.status === 'INITIATED';
  return {
    id: order.id,
    type: order.type,
    status: order.status,
    amountMinor: amount,
    vatMinor: vatPortion(amount, vatRate),
    currency: order.currency,
    errandId: order.targetErrandId,
    payment: payment
      ? { reference: payment.providerReference, status: payment.status, authorizationUrl: open ? payment.authorizationUrl : null }
      : null,
    paidAt: order.paidAt,
    createdAt: order.createdAt,
  };
}

/**
 * Orders (Backend PRD 22.2): what a user buys, at the price that is current when they ask.
 *
 * The order records the price version it used, so a later price change never alters an order. A
 * second create with the same idempotency key returns the first order and its checkout, and
 * creates nothing. The order is written before the gateway is called, so a gateway that fails
 * leaves an order the customer can see and retry, never a charge with no record.
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: BusinessConfigService,
    private readonly appConfig: ConfigService,
    private readonly pricing: PricingService,
    private readonly cursors: CursorService,
    private readonly boosts: BoostService,
    private readonly verification: VerificationStatusService,
    @Inject(PAYMENT_PROVIDER) private readonly gateway: IPaymentProvider,
  ) {}

  // ---- Catalogue ----

  async products(): Promise<ProductDto[]> {
    const [vatRate, proDays] = await Promise.all([this.config.get('VAT_RATE'), this.config.get('RUNNER_PRO_PERIOD_DAYS')]);
    const out: ProductDto[] = [];
    for (const [orderType, code] of Object.entries(PRODUCT_CODE_BY_ORDER_TYPE) as Array<[OrderType, string]>) {
      const price = await this.pricing.getCurrentPriceByCode(code);
      if (!price) continue;
      const product = await this.prisma.commercialProduct.findFirst({ where: { code, deletedAt: null, active: true } });
      if (!product) continue;
      const amount = Number(price.amountKobo);
      out.push({
        code,
        name: product.name,
        orderType,
        priceMinor: amount,
        vatMinor: vatPortion(amount, vatRate),
        currency: price.currency,
        periodDays: orderType === 'RUNNER_PRO' ? proDays : null,
      });
    }
    return out;
  }

  // ---- Create ----

  async create(userId: string, input: CreateOrderInput, idempotencyKey: string): Promise<OrderDto> {
    const vatRate = await this.config.get('VAT_RATE');
    const existing = await this.prisma.order.findFirst({ where: { userId, idempotencyKey } });
    if (existing) {
      const last = await this.latestPayment(existing.id);
      // A checkout that never opened (the gateway was down) is tried again on the same key.
      if (existing.status === 'FAILED' && last && last.status === 'FAILED' && !last.authorizationUrl) {
        return this.retryCheckout(existing, userId);
      }
      return toOrderDto(existing, last, vatRate);
    }

    await this.assertEligible(userId, input);
    const price = await this.pricing.getCurrentPriceByCode(PRODUCT_CODE_BY_ORDER_TYPE[input.type]);
    if (!price) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'This product is not available.', details: { reason: 'NO_PRICE' } });
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true } });
    const amount = Number(price.amountKobo);
    const metadata: Prisma.InputJsonObject | undefined =
      input.type === 'RUNNER_PRO' ? { autoRenew: input.autoRenew === true } : undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO orders (user_id, type, product_id, price_version_id, amount_minor, currency, target_errand_id, idempotency_key, metadata, updated_at)
        VALUES (${userId}::uuid, ${input.type}::"OrderType", ${price.productId}::uuid, ${price.id}::uuid, ${amount}, ${price.currency},
                ${input.errandId ?? null}::uuid, ${idempotencyKey}, ${metadata ? JSON.stringify(metadata) : null}::jsonb, clock_timestamp())
        ON CONFLICT (user_id, idempotency_key) DO NOTHING
        RETURNING id::text
      `;
      if (!rows[0]) return null; // a parallel request with the same key got there first
      const reference = paymentReference(rows[0].id, randomBytes(4).toString('hex'));
      await tx.$executeRaw`
        INSERT INTO payments (order_id, provider, provider_reference, status, amount_minor, updated_at)
        VALUES (${rows[0].id}::uuid, ${PAYMENT_PROVIDER_NAME}, ${reference}, 'INITIATED'::"PaymentStatus", ${amount}, clock_timestamp())
      `;
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'order.created',
        entityType: 'order',
        entityId: rows[0].id,
        metadata: { type: input.type, amountMinor: amount, errandId: input.errandId ?? null },
      });
      return { orderId: rows[0].id, reference };
    });

    if (!created) {
      const winner = await this.prisma.order.findFirstOrThrow({ where: { userId, idempotencyKey } });
      return toOrderDto(winner, await this.latestPayment(winner.id), vatRate);
    }

    if (amount === 0) {
      // Nothing to collect: no gateway call. The order is settled by the caller's settlement path.
      return this.view(created.orderId);
    }
    await this.openCheckout(created.orderId, created.reference, gatewayEmail(user), amount, input.type);
    return this.view(created.orderId);
  }

  private async retryCheckout(order: Order, userId: string): Promise<OrderDto> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true } });
    const reference = paymentReference(order.id, randomBytes(4).toString('hex'));
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: 'PENDING' } });
      await tx.payment.create({
        data: { orderId: order.id, provider: PAYMENT_PROVIDER_NAME, providerReference: reference, status: 'INITIATED', amountMinor: order.amountMinor },
      });
    });
    await this.openCheckout(order.id, reference, gatewayEmail(user), Number(order.amountMinor), order.type);
    return this.view(order.id);
  }

  async get(userId: string, orderId: string): Promise<OrderDto> {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId } });
    if (!order) throw DomainException.of(RESOURCE_NOT_FOUND);
    return toOrderDto(order, await this.latestPayment(order.id), await this.config.get('VAT_RATE'));
  }

  async listMine(userId: string, query: OrderListQueryDto): Promise<Paginated<OrderDto>> {
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await this.prisma.order.findMany({
      where: {
        userId,
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt as Date } }, { createdAt: cursor.createdAt as Date, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const vatRate = await this.config.get('VAT_RATE');
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const items: OrderDto[] = [];
    for (const row of page) items.push(toOrderDto(row, await this.latestPayment(row.id), vatRate));
    return new Paginated(items, {
      hasNextPage,
      ...(hasNextPage && last
        ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) }
        : {}),
    });
  }

  /**
   * A renewal order for an existing Pro subscription (no checkout: the stored authorisation is
   * charged). One per period and day, by its key.
   */
  async createRenewal(userId: string, key: string): Promise<{ orderId: string; paymentId: string; reference: string; amountKobo: number; email: string }> {
    const price = await this.pricing.getCurrentPriceByCode(PRODUCT_CODE_BY_ORDER_TYPE.RUNNER_PRO);
    if (!price) throw DomainException.of(RESOURCE_CONFLICT, { message: 'This product is not available.' });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true } });
    const amount = Number(price.amountKobo);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO orders (user_id, type, product_id, price_version_id, amount_minor, currency, idempotency_key, metadata, updated_at)
      VALUES (${userId}::uuid, 'RUNNER_PRO'::"OrderType", ${price.productId}::uuid, ${price.id}::uuid, ${amount}, ${price.currency},
              ${key}, ${JSON.stringify({ renewal: true })}::jsonb, clock_timestamp())
      ON CONFLICT (user_id, idempotency_key) DO UPDATE SET updated_at = clock_timestamp()
      RETURNING id::text
    `;
    const orderId = rows[0].id;
    const existing = await this.prisma.payment.findFirst({ where: { orderId }, orderBy: { id: 'desc' } });
    if (existing) {
      return { orderId, paymentId: existing.id, reference: existing.providerReference, amountKobo: amount, email: gatewayEmail(user) };
    }
    const reference = paymentReference(orderId, randomBytes(4).toString('hex'));
    const payment = await this.prisma.payment.create({
      data: { orderId, provider: PAYMENT_PROVIDER_NAME, providerReference: reference, status: 'INITIATED', amountMinor: BigInt(amount) },
    });
    return { orderId, paymentId: payment.id, reference, amountKobo: amount, email: gatewayEmail(user) };
  }

  // ---- Internals ----

  private async assertEligible(userId: string, input: CreateOrderInput): Promise<void> {
    if (input.type === 'BOOST') {
      if (!input.errandId) {
        throw DomainException.of(VALIDATION_ERROR, { message: 'A boost needs the errand to boost.', details: { field: 'errandId' } });
      }
      await this.boosts.assertEligible(userId, input.errandId);
      return;
    }
    if (input.errandId) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'This product is not for an errand.', details: { field: 'errandId' } });
    }
    if (input.type === 'RUNNER_PRO') {
      const profile = await this.prisma.runnerProfile.findFirst({ where: { userId, deletedAt: null }, select: { userId: true } });
      if (!profile) {
        throw DomainException.of(RESOURCE_CONFLICT, { message: 'Set up your runner profile first.', details: { reason: 'NO_RUNNER_PROFILE' } });
      }
      return;
    }
    // VERIFICATION_FEE
    const price = await this.pricing.getCurrentPriceByCode(PRODUCT_CODE_BY_ORDER_TYPE.VERIFICATION_FEE);
    const fee = price ? Number(price.amountKobo) : await this.config.get('VERIFICATION_FEE');
    if (fee <= 0) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'Verification is free right now. Nothing to pay.', details: { reason: 'NO_FEE' } });
    }
    if (await this.verification.isVerified(userId)) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'You are already verified.', details: { reason: 'ALREADY_VERIFIED' } });
    }
  }

  /** Ask the gateway for a checkout. A failure leaves the order FAILED and tells the caller to retry. */
  private async openCheckout(orderId: string, reference: string, email: string, amountKobo: number, type: OrderType): Promise<void> {
    const callbackUrl = this.appConfig.get<string>('paystack.callbackUrl') || undefined;
    try {
      const result = await this.gateway.initializeTransaction({
        email,
        amountKobo,
        reference,
        callbackUrl,
        metadata: { orderId, type },
      });
      const payment = await this.prisma.payment.findFirstOrThrow({ where: { providerReference: reference } });
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({ where: { id: payment.id }, data: { authorizationUrl: result.authorizationUrl } });
        await tx.paymentAttempt.create({ data: { paymentId: payment.id, kind: 'INITIALIZE', status: 'ok', providerResponse: { accessCode: result.accessCode } } });
      });
    } catch (error) {
      this.logger.error(`Could not open checkout for order ${orderId}: ${error instanceof Error ? error.message : String(error)}`);
      const payment = await this.prisma.payment.findFirst({ where: { providerReference: reference } });
      await this.prisma.$transaction(async (tx) => {
        if (payment) {
          await tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
          await tx.paymentAttempt.create({
            data: { paymentId: payment.id, kind: 'INITIALIZE', status: 'failed', providerResponse: { error: error instanceof ProviderError ? 'PROVIDER_ERROR' : 'UNKNOWN' } },
          });
        }
        await tx.order.update({ where: { id: orderId }, data: { status: 'FAILED' } });
      });
      throw DomainException.of(PAYMENT_PROVIDER_UNAVAILABLE, { details: { orderId } });
    }
  }

  private async view(orderId: string): Promise<OrderDto> {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    return toOrderDto(order, await this.latestPayment(orderId), await this.config.get('VAT_RATE'));
  }

  private latestPayment(orderId: string): Promise<Payment | null> {
    // By id, not created_at: ids are time-ordered by the database clock, whichever client wrote the row.
    return this.prisma.payment.findFirst({ where: { orderId }, orderBy: { id: 'desc' } });
  }
}

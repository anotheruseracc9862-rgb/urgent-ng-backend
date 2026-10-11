import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { RequiresFlag } from '../common/decorators/requires-flag.decorator.js';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { OrderService } from './order.service.js';
import { PaymentSettlementService } from './payment-settlement.service.js';
import { WebhookService } from './webhook.service.js';
import { ProSubscriptionService } from '../subscriptions/pro-subscription.service.js';
import {
  CreateBoostDto,
  CreateOrderDto,
  OrderDto,
  OrderListQueryDto,
  ProductDto,
  ProSubscriptionDto,
  WebhookAckDto,
} from './billing.dto.js';

/**
 * Platform purchases (Backend PRD 22, 30.8): Runner Pro, boosts and the verification fee. The
 * errand payment between requester and runner never comes through here.
 *
 * Buying is blocked by the `FEATURE_BILLING_ENABLED` kill switch; reading, cancelling and the
 * webhook are not, so money already in flight still settles.
 */
@ApiTags('Billing')
@Controller()
export class BillingController {
  constructor(
    private readonly orders: OrderService,
    private readonly settlement: PaymentSettlementService,
  ) {}

  @Get('billing/products')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ProductDto, { isArray: true })
  products() {
    return this.orders.products();
  }

  @Post('billing/orders')
  @Idempotent({ operation: 'billing-order-create' })
  @RequiresFlag('FEATURE_BILLING_ENABLED')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(OrderDto, { status: 201 })
  @ApiErrors(400, 404, 409, 503)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto, @Headers('idempotency-key') key: string) {
    return this.orders.create(user.userId, { type: dto.type, autoRenew: dto.autoRenew }, key);
  }

  @Get('billing/orders')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(OrderDto, { isArray: true })
  @ApiErrors(400)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: OrderListQueryDto) {
    return this.orders.listMine(user.userId, query);
  }

  @Get('billing/orders/:id')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(OrderDto)
  @ApiErrors(404)
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(user.userId, id);
  }

  /**
   * "I paid, check it": asks the gateway what happened and settles if it is paid. The browser's
   * word is never taken; this is the same path as the webhook and is safe to call repeatedly.
   */
  @Post('billing/orders/:id/verify')
  @HttpCode(200)
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(OrderDto)
  @ApiErrors(404)
  async verify(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    const order = await this.orders.get(user.userId, id);
    if (order.payment && order.status === 'PENDING') {
      await this.settlement.settle(order.payment.reference, 'VERIFY');
    }
    return this.orders.get(user.userId, id);
  }
}

/** `POST /boosts` (Backend PRD 30.8): a boost is an order for one open errand. */
@ApiTags('Billing')
@Controller()
export class BoostPurchaseController {
  constructor(private readonly orders: OrderService) {}

  @Post('boosts')
  @Idempotent({ operation: 'boost-purchase' })
  @RequiresFlag('FEATURE_BILLING_ENABLED')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(OrderDto, { status: 201 })
  @ApiErrors(400, 404, 409, 503)
  buy(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBoostDto, @Headers('idempotency-key') key: string) {
    return this.orders.create(user.userId, { type: 'BOOST', errandId: dto.errandId }, key);
  }
}

/** Runner Pro status and cancelling auto-renew (Backend PRD 22.4). */
@ApiTags('Billing')
@Controller('subscriptions/pro')
export class ProSubscriptionController {
  constructor(private readonly pro: ProSubscriptionService) {}

  @Get()
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ProSubscriptionDto)
  current(@CurrentUser() user: AuthenticatedUser) {
    return this.pro.current(user.userId);
  }

  @Post('cancel')
  @HttpCode(200)
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ProSubscriptionDto)
  @ApiErrors(403)
  cancel(@CurrentUser() user: AuthenticatedUser) {
    return this.pro.cancel(user.userId);
  }
}

/**
 * The gateway's webhook (Backend PRD 22.2). Public, signature-checked against the raw body,
 * idempotent. It must answer quickly and an error answer makes the gateway retry.
 */
@ApiTags('Billing')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  @Post('paystack')
  @HttpCode(200)
  @RateLimit('global')
  @ApiEnveloped(WebhookAckDto)
  @ApiErrors(400, 403)
  async paystack(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-paystack-signature') signature: string | undefined) {
    if (!req.rawBody) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'The request body is missing.' });
    }
    const result = await this.webhooks.handle(req.rawBody, signature);
    return { received: true, result };
  }
}

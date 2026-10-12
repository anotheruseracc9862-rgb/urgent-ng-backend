import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuditActorType, OrderStatus, OrderType, PaymentStatus, Prisma, RefundStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { PrismaService } from '../../database/prisma.service.js';
import { Paginated } from '../../common/pagination/paginated.js';
import { PaginationQueryDto } from '../../common/pagination/pagination.dto.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../../common/constants/error-codes.js';
import { ApiEnveloped, ApiErrors } from '../../common/api/api-docs.js';
import { ReqCtx } from '../../auth/decorators/request-context.decorator.js';
import type { RequestContext } from '../../auth/auth-audit.service.js';
import { AdminAuth, CurrentAdmin, type AuthenticatedAdmin } from '../../admin/decorators/admin-auth.decorator.js';
import { AdminActionService } from '../../admin/framework/admin-action.service.js';
import { AdminActionDto } from '../../admin/framework/admin-reasons.js';
import { RefundService } from '../../billing/refund.service.js';
import { WebhookService } from '../../billing/webhook.service.js';
import { ReconciliationService } from '../../billing/reconciliation.service.js';
import { ProSubscriptionService } from '../../subscriptions/pro-subscription.service.js';
import { BoostService } from '../../boosts/boost.service.js';
import { OfferLimitService } from '../../entitlements/offer-limit.service.js';
import { EntitlementAdminService } from '../../entitlements/entitlement-admin.service.js';
import { AdminPager, likePattern } from '../common/admin-page.js';
import { AnyObjectDto } from '../common/any-object.dto.js';

// ---- DTOs ----

export class OrderListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: OrderStatus }) @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @ApiPropertyOptional({ enum: OrderType }) @IsOptional() @IsEnum(OrderType) type?: OrderType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;
  @ApiPropertyOptional({ description: 'A payment reference, or part of the buyer name.', maxLength: 80 }) @IsOptional() @IsString() @MaxLength(80) q?: string;
}

export class PaymentListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus }) @IsOptional() @IsEnum(PaymentStatus) status?: PaymentStatus;
  @ApiPropertyOptional({ maxLength: 80 }) @IsOptional() @IsString() @MaxLength(80) q?: string;
}

export class RefundListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RefundStatus, default: 'REQUESTED' }) @IsOptional() @IsEnum(RefundStatus) status?: RefundStatus;
}

export class WebhookListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED_DUPLICATE'] })
  @IsOptional() @IsIn(['RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED_DUPLICATE']) status?: string;
}

export class SubscriptionListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) status?: string;
}

export class BoostListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'PURCHASED', 'SCHEDULED'] })
  @IsOptional() @IsIn(['ACTIVE', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'PURCHASED', 'SCHEDULED']) status?: string;
}

export class RequestRefundDto extends AdminActionDto {
  @ApiPropertyOptional({ description: 'Kobo. Leave out to refund what is left of the payment.' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) amountMinor?: number;
}

export class GrantProDto extends AdminActionDto {
  @ApiProperty({ minimum: 1, maximum: 366 }) @Type(() => Number) @IsInt() @Min(1) @Max(366) days!: number;
}

export class ExtendBoostDto extends AdminActionDto {
  @ApiProperty({ minimum: 1, maximum: 72 }) @Type(() => Number) @IsInt() @Min(1) @Max(72) hours!: number;
}

export class GrantEntitlementDto extends AdminActionDto {
  @ApiProperty({ enum: ['RUNNER_PRO', 'VERIFICATION_ATTEMPT_ALLOWANCE'] })
  @IsIn(['RUNNER_PRO', 'VERIFICATION_ATTEMPT_ALLOWANCE']) type!: 'RUNNER_PRO' | 'VERIFICATION_ATTEMPT_ALLOWANCE';
  @ApiPropertyOptional({ minimum: 1, maximum: 366 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(366) days?: number;
  @ApiPropertyOptional({ minimum: 1, maximum: 20, description: 'Attempts, for VERIFICATION_ATTEMPT_ALLOWANCE.' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) quantity?: number;
}

export class ResetOfferLimitDto extends AdminActionDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, description: 'Give back this many offers today. Leave out to reset today to zero.' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) extra?: number;
}

export class BillingRowDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: Date }) createdAt!: Date;
  @ApiProperty({ type: Object, description: 'The row fields. Money is in kobo.' }) data!: Record<string, unknown>;
}

// ---- Service ----

@Injectable()
export class AdminBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pager: AdminPager,
  ) {}

  async orders(q: { status?: OrderStatus; type?: OrderType; userId?: string; q?: string; cursor?: string; limit?: number }): Promise<Paginated<BillingRowDto>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const c: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (q.status) c.push(Prisma.sql`o.status = ${q.status}::"OrderStatus"`);
    if (q.type) c.push(Prisma.sql`o.type = ${q.type}::"OrderType"`);
    if (q.userId) c.push(Prisma.sql`o.user_id = ${q.userId}::uuid`);
    if (q.q?.trim()) {
      const like = likePattern(q.q);
      c.push(Prisma.sql`(u.name ILIKE ${like} OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.provider_reference ILIKE ${like}))`);
    }
    if (after) c.push(Prisma.sql`(o.created_at, o.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; user_id: string; user_name: string; type: string; status: string; amount_minor: bigint; paid_at: Date | null; created_at: Date; reference: string | null }>
    >`
      SELECT o.id::text AS id, o.user_id::text AS user_id, u.name AS user_name, o.type::text AS type, o.status::text AS status,
             o.amount_minor, o.paid_at, o.created_at,
             (SELECT p.provider_reference FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS reference
      FROM orders o JOIN users u ON u.id = o.user_id
      WHERE ${Prisma.join(c, ' AND ')}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit + 1}
    `;
    return this.pager.page(rows.map((r) => ({ ...r, createdAt: r.created_at })), limit, (r): BillingRowDto => ({
      id: r.id,
      createdAt: r.created_at,
      data: { userId: r.user_id, userName: r.user_name, type: r.type, status: r.status, amountMinor: Number(r.amount_minor), paidAt: r.paid_at, reference: r.reference },
    }));
  }

  async orderDetail(orderId: string): Promise<Record<string, unknown>> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw DomainException.of(RESOURCE_NOT_FOUND);
    const [payments, buyer] = await Promise.all([
      this.prisma.payment.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
      this.prisma.user.findFirst({ where: { id: order.userId }, select: { id: true, name: true } }),
    ]);
    const paymentIds = payments.map((p) => p.id);
    const [refunds, attempts] = await Promise.all([
      this.prisma.refund.findMany({ where: { paymentId: { in: paymentIds } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.paymentAttempt.findMany({ where: { paymentId: { in: paymentIds } }, orderBy: { id: 'asc' } }),
    ]);
    return {
      id: order.id,
      type: order.type,
      status: order.status,
      amountMinor: Number(order.amountMinor),
      currency: order.currency,
      buyer,
      targetErrandId: order.targetErrandId,
      metadata: order.metadata,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
      payments: payments.map((p) => ({
        id: p.id,
        reference: p.providerReference,
        status: p.status,
        amountMinor: Number(p.amountMinor),
        paidAt: p.paidAt,
        attempts: attempts.filter((a) => a.paymentId === p.id).map((a) => ({ kind: a.kind, status: a.status, at: a.createdAt })),
      })),
      refunds: refunds.map((r) => ({ id: r.id, status: r.status, amountMinor: Number(r.amountMinor), reason: r.reason, createdAt: r.createdAt })),
    };
  }

  async payments(q: { status?: PaymentStatus; q?: string; cursor?: string; limit?: number }): Promise<Paginated<BillingRowDto>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const c: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (q.status) c.push(Prisma.sql`p.status = ${q.status}::"PaymentStatus"`);
    if (q.q?.trim()) c.push(Prisma.sql`p.provider_reference ILIKE ${likePattern(q.q)}`);
    if (after) c.push(Prisma.sql`(p.created_at, p.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; order_id: string; provider_reference: string; status: string; amount_minor: bigint; paid_at: Date | null; created_at: Date }>
    >`
      SELECT p.id::text AS id, p.order_id::text AS order_id, p.provider_reference, p.status::text AS status, p.amount_minor, p.paid_at, p.created_at
      FROM payments p WHERE ${Prisma.join(c, ' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit + 1}
    `;
    return this.pager.page(rows.map((r) => ({ ...r, createdAt: r.created_at })), limit, (r): BillingRowDto => ({
      id: r.id,
      createdAt: r.created_at,
      data: { orderId: r.order_id, reference: r.provider_reference, status: r.status, amountMinor: Number(r.amount_minor), paidAt: r.paid_at },
    }));
  }

  async refunds(q: { status?: RefundStatus; cursor?: string; limit?: number }): Promise<Paginated<BillingRowDto>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const rows = await this.prisma.refund.findMany({
      where: {
        status: q.status ?? 'REQUESTED',
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return this.pager.page(rows, limit, (r): BillingRowDto => ({
      id: r.id,
      createdAt: r.createdAt,
      data: {
        paymentId: r.paymentId,
        amountMinor: Number(r.amountMinor),
        status: r.status,
        reason: r.reason,
        requestedByType: r.requestedByType,
        requestedById: r.requestedById,
        approvedBy: r.approvedBy,
        failureReason: r.failureReason,
      },
    }));
  }

  async webhooks(q: { status?: string; cursor?: string; limit?: number }): Promise<Paginated<BillingRowDto>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const rows = await this.prisma.webhookEvent.findMany({
      where: {
        ...(q.status ? { processingStatus: q.status as never } : {}),
        ...(after ? { OR: [{ receivedAt: { lt: after.createdAt } }, { receivedAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return this.pager.page(rows.map((r) => ({ ...r, createdAt: r.receivedAt })), limit, (r): BillingRowDto => ({
      id: r.id,
      createdAt: r.receivedAt,
      data: {
        provider: r.provider,
        eventType: r.eventType,
        signatureValid: r.signatureValid,
        status: r.processingStatus,
        reference: r.payloadRef,
        failureReason: r.failureReason,
        duplicateCount: r.duplicateCount,
        processedAt: r.processedAt,
      },
    }));
  }

  async subscriptions(q: { status?: string; cursor?: string; limit?: number }): Promise<Paginated<BillingRowDto>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; user_id: string; user_name: string; status: string; current_period_end: Date; grace_ends_at: Date | null; auto_renew: boolean; created_at: Date }>
    >`
      SELECT s.id::text AS id, s.user_id::text AS user_id, u.name AS user_name, s.status::text AS status, s.current_period_end,
             s.grace_ends_at, s.auto_renew, s.created_at
      FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE (${q.status ?? null}::text IS NULL OR s.status::text = ${q.status ?? null})
        AND (${after?.createdAt ?? null}::timestamptz IS NULL OR (s.created_at, s.id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
      ORDER BY s.created_at DESC, s.id DESC LIMIT ${limit + 1}
    `;
    return this.pager.page(rows.map((r) => ({ ...r, createdAt: r.created_at })), limit, (r): BillingRowDto => ({
      id: r.id,
      createdAt: r.created_at,
      data: { userId: r.user_id, userName: r.user_name, status: r.status, currentPeriodEnd: r.current_period_end, graceEndsAt: r.grace_ends_at, autoRenew: r.auto_renew },
    }));
  }

  async boosts(q: { status?: string; cursor?: string; limit?: number }): Promise<Paginated<BillingRowDto>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; errand_id: string; title: string; status: string; activates_at: Date | null; expires_at: Date | null; ended_reason: string | null; created_at: Date }>
    >`
      SELECT b.id::text AS id, b.errand_id::text AS errand_id, e.title, b.status::text AS status, b.activates_at, b.expires_at, b.ended_reason, b.created_at
      FROM boosts b JOIN errands e ON e.id = b.errand_id
      WHERE (${q.status ?? null}::text IS NULL OR b.status::text = ${q.status ?? null})
        AND (${after?.createdAt ?? null}::timestamptz IS NULL OR (b.created_at, b.id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
      ORDER BY b.created_at DESC, b.id DESC LIMIT ${limit + 1}
    `;
    return this.pager.page(rows.map((r) => ({ ...r, createdAt: r.created_at })), limit, (r): BillingRowDto => ({
      id: r.id,
      createdAt: r.created_at,
      data: { errandId: r.errand_id, errandTitle: r.title, status: r.status, activatesAt: r.activates_at, expiresAt: r.expires_at, endedReason: r.ended_reason },
    }));
  }

  async requireUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({ where: { id: userId }, select: { id: true } });
    if (!user) throw DomainException.of(RESOURCE_NOT_FOUND);
  }

  async paymentExists(paymentId: string): Promise<void> {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId }, select: { id: true } });
    if (!p) throw DomainException.of(RESOURCE_NOT_FOUND);
  }
}

// ---- Controller ----

/** Billing, subscriptions, boosts, refunds and offer limits (Backend PRD 24.4 areas 11 to 13). */
@ApiTags('Admin billing')
@Controller('admin')
export class AdminBillingController {
  constructor(
    private readonly service: AdminBillingService,
    private readonly refunds: RefundService,
    private readonly webhooks: WebhookService,
    private readonly reconciliation: ReconciliationService,
    private readonly pro: ProSubscriptionService,
    private readonly boostService: BoostService,
    private readonly offerLimits: OfferLimitService,
    private readonly entitlements: EntitlementAdminService,
    private readonly actions: AdminActionService,
  ) {}

  @Get('orders')
  @AdminAuth('BILLING_VIEW')
  @ApiEnveloped(BillingRowDto, { isArray: true })
  @ApiErrors(400)
  orders(@Query() query: OrderListQueryDto) {
    return this.service.orders(query);
  }

  @Get('orders/:id')
  @AdminAuth('BILLING_VIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(404)
  order(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.orderDetail(id);
  }

  @Get('payments')
  @AdminAuth('BILLING_VIEW')
  @ApiEnveloped(BillingRowDto, { isArray: true })
  payments(@Query() query: PaymentListQueryDto) {
    return this.service.payments(query);
  }

  @Get('refunds')
  @AdminAuth('BILLING_VIEW')
  @ApiEnveloped(BillingRowDto, { isArray: true })
  refundQueue(@Query() query: RefundListQueryDto) {
    return this.service.refunds(query);
  }

  @Get('webhooks')
  @AdminAuth('BILLING_VIEW')
  @ApiEnveloped(BillingRowDto, { isArray: true })
  webhookLog(@Query() query: WebhookListQueryDto) {
    return this.service.webhooks(query);
  }

  @Get('subscriptions')
  @AdminAuth('BILLING_VIEW')
  @ApiEnveloped(BillingRowDto, { isArray: true })
  subscriptions(@Query() query: SubscriptionListQueryDto) {
    return this.service.subscriptions(query);
  }

  @Get('boosts')
  @AdminAuth('BILLING_VIEW')
  @ApiEnveloped(BillingRowDto, { isArray: true })
  boosts(@Query() query: BoostListQueryDto) {
    return this.service.boosts(query);
  }

  /** Run a stored webhook event again. Idempotent: it asks the gateway, then settles once. */
  @Post('webhooks/:id/replay')
  @HttpCode(200)
  @AdminAuth('BILLING_VIEW', 'REFUNDS_APPROVE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  replay(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'webhook.replay',
      entityType: 'webhook_event',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.webhooks.replay(id),
    });
  }

  /** Check every unsettled payment and the recent paid ones against the gateway now. */
  @Post('billing/reconcile')
  @HttpCode(200)
  @AdminAuth('BILLING_VIEW', 'REFUNDS_APPROVE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403)
  reconcile(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'billing.reconcile',
      entityType: 'billing',
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.reconciliation.run(),
    });
  }

  /** Ask for a refund. At or above the threshold it waits for a second admin to approve. */
  @Post('payments/:id/refund')
  @HttpCode(200)
  @AdminAuth('REFUNDS_APPROVE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async refund(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RequestRefundDto, @ReqCtx() ctx: RequestContext) {
    await this.service.paymentExists(id);
    const refund = await this.actions.run({
      admin,
      action: 'refund.request',
      entityType: 'payment',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { amountMinor: dto.amountMinor },
      execute: () =>
        this.refunds.request({
          paymentId: id,
          amountMinor: dto.amountMinor,
          reason: dto.reasonText ?? dto.reasonCode,
          actor: { type: AuditActorType.ADMIN, id: admin.adminId },
        }),
    });
    return { id: refund.id, status: refund.status, amountMinor: Number(refund.amountMinor), waitingForSecondAdmin: refund.status === 'REQUESTED' };
  }

  @Post('refunds/:id/approve')
  @HttpCode(200)
  @AdminAuth('REFUNDS_APPROVE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async approveRefund(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    const refund = await this.actions.run({
      admin,
      action: 'refund.approve',
      entityType: 'refund',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.refunds.approve(id, { adminId: admin.adminId }),
    });
    return { id: refund.id, status: refund.status };
  }

  @Post('refunds/:id/reject')
  @HttpCode(200)
  @AdminAuth('REFUNDS_APPROVE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async rejectRefund(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    const refund = await this.actions.run({
      admin,
      action: 'refund.reject',
      entityType: 'refund',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.refunds.reject(id, dto.reasonText ?? dto.reasonCode, { adminId: admin.adminId }),
    });
    return { id: refund.id, status: refund.status };
  }

  // ---- Runner Pro ----

  @Get('users/:id/pro')
  @AdminAuth('BILLING_VIEW')
  @ApiEnveloped(AnyObjectDto)
  async proOf(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.requireUser(id);
    return this.pro.current(id);
  }

  /** Grant Runner Pro for `days`, or extend a running period by that many. */
  @Post('users/:id/pro/grant')
  @HttpCode(200)
  @AdminAuth('SUBSCRIPTIONS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  async grantPro(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GrantProDto, @ReqCtx() ctx: RequestContext) {
    await this.service.requireUser(id);
    return this.actions.run({
      admin,
      action: 'subscription.grant',
      entityType: 'user',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { days: dto.days },
      execute: () => this.pro.adminGrant(id, dto.days, admin.adminId),
    });
  }

  /** End Runner Pro now. Refunding the money is a separate request. */
  @Post('users/:id/pro/end')
  @HttpCode(200)
  @AdminAuth('SUBSCRIPTIONS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 403)
  async endPro(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    await this.service.requireUser(id);
    return this.actions.run({
      admin,
      action: 'subscription.end',
      entityType: 'user',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.pro.adminEnd(id, admin.adminId),
    });
  }

  // ---- Boosts ----

  @Post('boosts/:id/end')
  @HttpCode(200)
  @AdminAuth('BOOSTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  endBoost(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'boost.end',
      entityType: 'boost',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.boostService.adminEnd(id, admin.adminId, dto.reasonText ?? dto.reasonCode),
    });
  }

  @Post('boosts/:id/extend')
  @HttpCode(200)
  @AdminAuth('BOOSTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  extendBoost(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtendBoostDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'boost.extend',
      entityType: 'boost',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { hours: dto.hours },
      execute: () => this.boostService.adminExtend(id, dto.hours, admin.adminId),
    });
  }

  // ---- Entitlements ----

  @Get('users/:id/entitlements')
  @AdminAuth('BILLING_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  async entitlementsOf(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.requireUser(id);
    return this.entitlements.list(id);
  }

  @Post('users/:id/entitlements')
  @HttpCode(200)
  @AdminAuth('SUBSCRIPTIONS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  grantEntitlement(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GrantEntitlementDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'entitlement.grant',
      entityType: 'user',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { type: dto.type, days: dto.days, quantity: dto.quantity },
      execute: () => this.entitlements.grant({ userId: id, type: dto.type, days: dto.days, quantity: dto.quantity }, admin.adminId),
    });
  }

  @Post('entitlements/:id/revoke')
  @HttpCode(200)
  @AdminAuth('SUBSCRIPTIONS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  revokeEntitlement(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'entitlement.revoke',
      entityType: 'entitlement',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.entitlements.revoke(id, admin.adminId),
    });
  }

  // ---- Offer limits ----

  @Get('offer-limits/:userId')
  @AdminAuth('BILLING_VIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(404)
  async offerLimit(@Param('userId', ParseUUIDPipe) userId: string) {
    await this.service.requireUser(userId);
    return this.offerLimits.getLimitStatus(userId);
  }

  @Post('offer-limits/:userId/reset')
  @HttpCode(200)
  @AdminAuth('SUBSCRIPTIONS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  async resetOfferLimit(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: ResetOfferLimitDto, @ReqCtx() ctx: RequestContext) {
    await this.service.requireUser(userId);
    return this.actions.run({
      admin,
      action: 'offer_limit.reset',
      entityType: 'user',
      entityId: userId,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { extra: dto.extra },
      execute: () => this.offerLimits.adminAdjust(userId, dto.extra),
    });
  }
}

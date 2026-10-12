import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { DsrStatus, DsrType, Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PrismaService } from '../../database/prisma.service.js';
import { Paginated } from '../../common/pagination/paginated.js';
import { PaginationQueryDto } from '../../common/pagination/pagination.dto.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { RESOURCE_CONFLICT, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../../common/constants/error-codes.js';
import { ApiEnveloped, ApiErrors } from '../../common/api/api-docs.js';
import { ReqCtx } from '../../auth/decorators/request-context.decorator.js';
import type { RequestContext } from '../../auth/auth-audit.service.js';
import { AdminAuth, CurrentAdmin, type AuthenticatedAdmin } from '../../admin/decorators/admin-auth.decorator.js';
import { AdminActionService } from '../../admin/framework/admin-action.service.js';
import { AdminActionDto } from '../../admin/framework/admin-reasons.js';
import { NotificationService } from '../../notifications/notification.service.js';
import { OutboxService } from '../../queue/outbox.service.js';
import { QUEUE_NAMES } from '../../queue/queue.registry.js';
import { RiskFlagService } from '../../risk/risk-flag.service.js';
import { AdminPager } from '../common/admin-page.js';
import { AnyObjectDto } from '../common/any-object.dto.js';

const ANNOUNCEMENT_MAX_AUDIENCE = 5000;
const ANNOUNCEMENT_KINDS = ['SECURITY', 'OUTAGE', 'POLICY', 'PAYMENT', 'SAFETY'] as const;

// ---- DTOs ----

export class DeliveryListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['QUEUED', 'SENT', 'FAILED', 'SUPPRESSED'] })
  @IsOptional() @IsIn(['QUEUED', 'SENT', 'FAILED', 'SUPPRESSED']) status?: string;
  @ApiPropertyOptional({ enum: ['IN_APP', 'PUSH', 'EMAIL', 'SMS'] })
  @IsOptional() @IsIn(['IN_APP', 'PUSH', 'EMAIL', 'SMS']) channel?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;
}

export class AnnouncementDto extends AdminActionDto {
  @ApiProperty({ enum: ANNOUNCEMENT_KINDS, description: 'Only service-critical notices go out this way.' })
  @IsIn(ANNOUNCEMENT_KINDS as unknown as string[]) kind!: (typeof ANNOUNCEMENT_KINDS)[number];
  @ApiProperty({ maxLength: 400 }) @IsString() @MinLength(5) @MaxLength(400) message!: string;
  @ApiProperty({ enum: ['USERS', 'ALL_ACTIVE', 'RUNNERS', 'REQUESTERS'] })
  @IsIn(['USERS', 'ALL_ACTIVE', 'RUNNERS', 'REQUESTERS']) audience!: 'USERS' | 'ALL_ACTIVE' | 'RUNNERS' | 'REQUESTERS';
  @ApiPropertyOptional({ type: String, isArray: true, description: 'The users, when the audience is USERS.' })
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID(undefined, { each: true }) userIds?: string[];
}

export class OutboxListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTERED'], default: 'DEAD_LETTERED' })
  @IsOptional() @IsIn(['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTERED']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) eventType?: string;
}

export class RiskFlagListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'REVIEWED', 'DISMISSED', 'ACTIONED'], default: 'OPEN' })
  @IsOptional() @IsIn(['OPEN', 'REVIEWED', 'DISMISSED', 'ACTIONED']) status?: 'OPEN' | 'REVIEWED' | 'DISMISSED' | 'ACTIONED';
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;
}

export class ReviewRiskFlagDto extends AdminActionDto {
  @ApiProperty({ enum: ['REVIEWED', 'DISMISSED', 'ACTIONED'] }) @IsIn(['REVIEWED', 'DISMISSED', 'ACTIONED']) status!: 'REVIEWED' | 'DISMISSED' | 'ACTIONED';
}

export class DsrListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DsrStatus }) @IsOptional() @IsEnum(DsrStatus) status?: DsrStatus;
  @ApiPropertyOptional({ enum: DsrType }) @IsOptional() @IsEnum(DsrType) type?: DsrType;
}

export class CreateDsrDto extends AdminActionDto {
  @ApiProperty({ enum: DsrType }) @IsEnum(DsrType) type!: DsrType;
  @ApiPropertyOptional({ description: 'The user, when they are one.' }) @IsOptional() @IsUUID() userId?: string;
  @ApiProperty({ maxLength: 500 }) @IsString() @MinLength(3) @MaxLength(500) summary!: string;
  @ApiPropertyOptional({ enum: ['SUPPORT', 'EMAIL', 'IN_APP', 'LEGAL'], default: 'SUPPORT' })
  @IsOptional() @IsIn(['SUPPORT', 'EMAIL', 'IN_APP', 'LEGAL']) channel?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 90, default: 30, description: 'Days to answer.' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) dueInDays?: number;
}

export class UpdateDsrDto extends AdminActionDto {
  @ApiProperty({ enum: ['IN_PROGRESS', 'COMPLETED', 'REJECTED'] }) @IsIn(['IN_PROGRESS', 'COMPLETED', 'REJECTED']) status!: 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED';
  @ApiPropertyOptional({ maxLength: 1000, description: 'What was done or why it was refused. Required to close.' })
  @IsOptional() @IsString() @MaxLength(1000) resolution?: string;
}

export class OpsRowDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: Date }) createdAt!: Date;
  @ApiProperty({ type: Object }) data!: Record<string, unknown>;
}

// ---- Service ----

@Injectable()
export class AdminOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pager: AdminPager,
    private readonly notifications: NotificationService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async deliveries(q: { status?: string; channel?: string; userId?: string; cursor?: string; limit?: number }): Promise<Paginated<OpsRowDto>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const c: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (q.status) c.push(Prisma.sql`d.status = ${q.status}`);
    if (q.channel) c.push(Prisma.sql`d.channel::text = ${q.channel}`);
    if (q.userId) c.push(Prisma.sql`n.user_id = ${q.userId}::uuid`);
    if (after) c.push(Prisma.sql`(d.created_at, d.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; notification_id: string; user_id: string; type: string; channel: string; status: string;
        suppressed_reason: string | null; attempts: number; last_error: string | null; created_at: Date;
      }>
    >`
      SELECT d.id::text AS id, d.notification_id::text AS notification_id, n.user_id::text AS user_id, n.type, d.channel::text AS channel,
             d.status, d.suppressed_reason, d.attempts, d.last_error, d.created_at
      FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
      WHERE ${Prisma.join(c, ' AND ')}
      ORDER BY d.created_at DESC, d.id DESC LIMIT ${limit + 1}
    `;
    return this.pager.page(rows.map((r) => ({ ...r, createdAt: r.created_at })), limit, (r): OpsRowDto => ({
      id: r.id,
      createdAt: r.created_at,
      data: {
        notificationId: r.notification_id, userId: r.user_id, type: r.type, channel: r.channel, status: r.status,
        suppressedReason: r.suppressed_reason, attempts: r.attempts, lastError: r.last_error,
      },
    }));
  }

  /** Try the failed deliveries of one notification again, from zero attempts. */
  async resend(notificationId: string): Promise<{ notificationId: string; retried: number; stillFailing: boolean }> {
    const exists = await this.prisma.notification.findUnique({ where: { id: notificationId }, select: { id: true } });
    if (!exists) throw DomainException.of(RESOURCE_NOT_FOUND);
    const reset = await this.prisma.$executeRaw`
      UPDATE notification_deliveries SET status = 'QUEUED', attempts = 0, last_error = NULL, updated_at = now()
      WHERE notification_id = ${notificationId}::uuid AND status = 'FAILED'
    `;
    let stillFailing = false;
    try {
      await this.notifications.deliverPending(notificationId);
    } catch {
      stillFailing = true;
    }
    return { notificationId, retried: reset, stillFailing };
  }

  /** A service-critical notice to a set of users. Sent through the notification engine, one notice each. */
  async announce(input: { kind: string; message: string; audience: string; userIds?: string[] }, adminId: string) {
    let ids: string[];
    if (input.audience === 'USERS') {
      if (!input.userIds || input.userIds.length === 0) {
        throw DomainException.of(VALIDATION_ERROR, { message: 'Name the users to tell.', details: { field: 'userIds' } });
      }
      ids = [...new Set(input.userIds)];
    } else {
      const filter =
        input.audience === 'RUNNERS'
          ? Prisma.sql`AND EXISTS (SELECT 1 FROM runner_profiles r WHERE r.user_id = u.id AND r.deleted_at IS NULL)`
          : input.audience === 'REQUESTERS'
            ? Prisma.sql`AND EXISTS (SELECT 1 FROM errands e WHERE e.requester_id = u.id AND e.status <> 'DRAFT'::"ErrandStatus")`
            : Prisma.empty;
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT u.id::text AS id FROM users u
        WHERE u.status = 'ACTIVE'::"UserStatus" AND u.deleted_at IS NULL ${filter}
        ORDER BY u.id LIMIT ${ANNOUNCEMENT_MAX_AUDIENCE + 1}
      `;
      if (rows.length > ANNOUNCEMENT_MAX_AUDIENCE) {
        throw DomainException.of(VALIDATION_ERROR, {
          message: `A notice goes to at most ${ANNOUNCEMENT_MAX_AUDIENCE} users at once. Narrow the audience.`,
          details: { field: 'audience' },
        });
      }
      ids = rows.map((r) => r.id);
    }
    const announcementId = randomUUID();
    let sent = 0;
    for (const userId of ids) {
      const result = await this.notifications.notify({
        userId,
        template: 'system.announcement',
        vars: { message: input.message },
        data: { announcementId, kind: input.kind },
        dedupeKey: `announcement:${announcementId}:${userId}`,
      });
      if (result.created) sent += 1;
    }
    return { announcementId, audience: ids.length, notified: sent, adminId };
  }

  async outbox(q: { status?: string; eventType?: string; cursor?: string; limit?: number }): Promise<Paginated<OpsRowDto>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const c: Prisma.Sql[] = [Prisma.sql`status::text = ${q.status ?? 'DEAD_LETTERED'}`];
    if (q.eventType) c.push(Prisma.sql`event_type = ${q.eventType}`);
    if (after) c.push(Prisma.sql`(occurred_at, id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; event_type: string; aggregate_type: string | null; aggregate_id: string | null; status: string; attempts: number; last_error: string | null; occurred_at: Date }>
    >`
      SELECT id::text AS id, event_type, aggregate_type, aggregate_id::text AS aggregate_id, status::text AS status, attempts, last_error, occurred_at
      FROM outbox_events WHERE ${Prisma.join(c, ' AND ')}
      ORDER BY occurred_at DESC, id DESC LIMIT ${limit + 1}
    `;
    return this.pager.page(rows.map((r) => ({ ...r, createdAt: r.occurred_at })), limit, (r): OpsRowDto => ({
      id: r.id,
      createdAt: r.occurred_at,
      data: { eventType: r.event_type, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id, status: r.status, attempts: r.attempts, lastError: r.last_error },
    }));
  }

  async outboxSummary(): Promise<Record<string, number>> {
    const rows = await this.prisma.$queryRaw<Array<{ status: string; n: number }>>`
      SELECT status::text AS status, count(*)::int AS n FROM outbox_events GROUP BY status
    `;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  async queues(): Promise<Array<{ name: string; counts: Record<string, number> }>> {
    const out: Array<{ name: string; counts: Record<string, number> }> = [];
    for (const name of Object.values(QUEUE_NAMES)) {
      try {
        const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
        out.push({ name, counts: (await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')) as Record<string, number> });
      } catch {
        out.push({ name, counts: {} });
      }
    }
    return out;
  }

  async sweepers() {
    const rows = await this.prisma.sweeperRun.findMany({ orderBy: { name: 'asc' } });
    const now = Date.now();
    return rows.map((r) => ({
      name: r.name,
      lastStartedAt: r.lastStartedAt,
      lastFinishedAt: r.lastFinishedAt,
      lastDurationMs: r.lastDurationMs,
      lastProcessed: r.lastProcessed,
      lastError: r.lastError,
      lastErrorAt: r.lastErrorAt,
      runs: Number(r.runs),
      failures: Number(r.failures),
      /** No sweep for five minutes: the scheduler is probably down. */
      stale: r.lastFinishedAt === null || now - r.lastFinishedAt.getTime() > 5 * 60_000,
    }));
  }

  // ---- data-subject requests ----

  async dsrList(q: { status?: DsrStatus; type?: DsrType; cursor?: string; limit?: number }): Promise<Paginated<OpsRowDto>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const rows = await this.prisma.dataSubjectRequest.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.type ? { type: q.type } : {}),
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const now = Date.now();
    return this.pager.page(rows, limit, (r): OpsRowDto => ({
      id: r.id,
      createdAt: r.createdAt,
      data: {
        type: r.type, status: r.status, userId: r.userId, channel: r.channel, summary: r.summary, dueAt: r.dueAt,
        overdue: ['OPEN', 'IN_PROGRESS'].includes(r.status) && r.dueAt.getTime() < now, assignedTo: r.assignedTo,
        resolution: r.resolution, resolvedAt: r.resolvedAt,
      },
    }));
  }

  async dsrCreate(input: CreateDsrDto, adminId: string) {
    if (input.userId) {
      const user = await this.prisma.user.findFirst({ where: { id: input.userId }, select: { id: true } });
      if (!user) throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    const days = input.dueInDays ?? 30;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; due_at: Date }>>`
      INSERT INTO data_subject_requests (user_id, type, channel, summary, due_at, created_by, updated_at)
      VALUES (${input.userId ?? null}::uuid, ${input.type}::"DsrType", ${input.channel ?? 'SUPPORT'}, ${input.summary.trim()},
              clock_timestamp() + make_interval(days => ${days}::int), ${adminId}::uuid, clock_timestamp())
      RETURNING id::text, due_at
    `;
    return { id: rows[0].id, dueAt: rows[0].due_at, status: 'OPEN' };
  }

  async dsrUpdate(id: string, input: UpdateDsrDto, adminId: string) {
    const row = await this.prisma.dataSubjectRequest.findUnique({ where: { id } });
    if (!row) throw DomainException.of(RESOURCE_NOT_FOUND);
    if (row.status === 'COMPLETED' || row.status === 'REJECTED') {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'This request is already closed.' });
    }
    const closing = input.status === 'COMPLETED' || input.status === 'REJECTED';
    if (closing && !input.resolution?.trim()) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'Say what was done, or why it was refused.', details: { field: 'resolution' } });
    }
    const updated = await this.prisma.dataSubjectRequest.update({
      where: { id },
      data: {
        status: input.status,
        assignedTo: row.assignedTo ?? adminId,
        ...(closing ? { resolution: input.resolution!.trim(), resolvedBy: adminId, resolvedAt: new Date() } : {}),
      },
    });
    return { id: updated.id, status: updated.status, resolvedAt: updated.resolvedAt };
  }
}

// ---- Controller ----

/** Notifications and operations (Backend PRD 24.4 areas 16, 17 and 18). */
@ApiTags('Admin operations')
@Controller('admin')
export class AdminOperationsController {
  constructor(
    private readonly service: AdminOperationsService,
    private readonly outboxService: OutboxService,
    private readonly risk: RiskFlagService,
    private readonly actions: AdminActionService,
  ) {}

  // ---- Notifications ----

  @Get('notifications/deliveries')
  @AdminAuth('OPS_VIEW')
  @ApiEnveloped(OpsRowDto, { isArray: true })
  @ApiErrors(400)
  deliveries(@Query() query: DeliveryListQueryDto) {
    return this.service.deliveries(query);
  }

  @Post('notifications/:id/resend')
  @HttpCode(200)
  @AdminAuth('NOTIFICATIONS_SEND')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  resend(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'notification.resend',
      entityType: 'notification',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.service.resend(id),
    });
  }

  /** A service-critical notice (security, outage, policy, payment, safety). Not marketing. */
  @Post('notifications/announcements')
  @HttpCode(200)
  @AdminAuth('NOTIFICATIONS_SEND')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403)
  announce(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: AnnouncementDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'notification.announce',
      entityType: 'announcement',
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { kind: dto.kind, audience: dto.audience },
      execute: () => this.service.announce(dto, admin.adminId),
    });
  }

  // ---- Outbox and queues ----

  @Get('ops/outbox')
  @AdminAuth('OPS_VIEW')
  @ApiEnveloped(OpsRowDto, { isArray: true })
  @ApiErrors(400)
  outbox(@Query() query: OutboxListQueryDto) {
    return this.service.outbox(query);
  }

  @Get('ops/outbox/summary')
  @AdminAuth('OPS_VIEW')
  @ApiEnveloped(AnyObjectDto)
  outboxSummary() {
    return this.service.outboxSummary();
  }

  @Post('ops/outbox/:id/retry')
  @HttpCode(200)
  @AdminAuth('OPS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  retry(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'outbox.retry',
      entityType: 'outbox_event',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: async () => {
        try {
          await this.outboxService.retryDeadLettered(id);
        } catch {
          throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'No dead-lettered event with this id.' });
        }
        return { id, status: 'PENDING' };
      },
    });
  }

  @Get('ops/queues')
  @AdminAuth('OPS_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  queues() {
    return this.service.queues();
  }

  @Get('ops/sweepers')
  @AdminAuth('OPS_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  sweepers() {
    return this.service.sweepers();
  }

  // ---- Risk flags ----

  @Get('ops/risk-flags')
  @AdminAuth('OPS_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  @ApiErrors(400)
  async riskFlags(@Query() query: RiskFlagListQueryDto) {
    const page = await this.risk.list({ status: query.status ?? 'OPEN', userId: query.userId, cursor: query.cursor, limit: query.limit });
    return page;
  }

  @Post('ops/risk-flags/:id/review')
  @HttpCode(200)
  @AdminAuth('OPS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async reviewFlag(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewRiskFlagDto, @ReqCtx() ctx: RequestContext) {
    const flag = await this.actions.run({
      admin,
      action: 'risk_flag.review',
      entityType: 'risk_flag',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { status: dto.status },
      execute: () => this.risk.review(id, dto.status, dto.reasonText ?? dto.reasonCode, { adminId: admin.adminId }),
    });
    return { id: flag.id, status: flag.status };
  }

  // ---- Data-subject requests ----

  @Get('ops/data-requests')
  @AdminAuth('DSR_MANAGE')
  @ApiEnveloped(OpsRowDto, { isArray: true })
  @ApiErrors(400)
  dsrs(@Query() query: DsrListQueryDto) {
    return this.service.dsrList(query);
  }

  @Post('ops/data-requests')
  @AdminAuth('DSR_MANAGE')
  @ApiEnveloped(AnyObjectDto, { status: 201 })
  @ApiErrors(400, 403, 404)
  createDsr(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: CreateDsrDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'dsr.create',
      entityType: 'data_subject_request',
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { type: dto.type },
      execute: () => this.service.dsrCreate(dto, admin.adminId),
    });
  }

  @Post('ops/data-requests/:id')
  @HttpCode(200)
  @AdminAuth('DSR_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  updateDsr(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDsrDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'dsr.update',
      entityType: 'data_subject_request',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { status: dto.status },
      execute: () => this.service.dsrUpdate(id, dto, admin.adminId),
    });
  }
}


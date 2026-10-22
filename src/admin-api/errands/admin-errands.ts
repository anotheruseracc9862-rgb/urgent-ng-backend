import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AssignmentStatus, CategoryFlow, ErrandStatus, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { PrismaService } from '../../database/prisma.service.js';
import { Paginated } from '../../common/pagination/paginated.js';
import { PaginationQueryDto } from '../../common/pagination/pagination.dto.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { ERRAND_INVALID_STATE, RESOURCE_NOT_FOUND } from '../../common/constants/error-codes.js';
import { ApiEnveloped, ApiErrors } from '../../common/api/api-docs.js';
import { ReqCtx } from '../../auth/decorators/request-context.decorator.js';
import type { RequestContext } from '../../auth/auth-audit.service.js';
import { AdminAuth, CurrentAdmin, type AuthenticatedAdmin } from '../../admin/decorators/admin-auth.decorator.js';
import { AdminActionService } from '../../admin/framework/admin-action.service.js';
import { AdminActionDto } from '../../admin/framework/admin-reasons.js';
import { SensitiveAccessService } from '../../admin/framework/sensitive-access.service.js';
import { ErrandStateService } from '../../errands/errand-state.service.js';
import { ErrandLifecycleService } from '../../errands/errand-lifecycle.service.js';
import { OfferService } from '../../offers/offer.service.js';
import { EnforcementService } from '../../enforcement/enforcement.service.js';
import { AdminPager, likePattern } from '../common/admin-page.js';
import { AnyObjectDto } from '../common/any-object.dto.js';

// ---- DTOs ----

export class AdminErrandListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Title, description, requester name, or an errand id.', maxLength: 80 })
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @ApiPropertyOptional({ enum: ErrandStatus }) @IsOptional() @IsEnum(ErrandStatus) status?: ErrandStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() requesterId?: string;
}

export class AdminErrandRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: ErrandStatus }) status!: ErrandStatus;
  @ApiProperty() category!: string;
  @ApiProperty({ enum: CategoryFlow }) categoryFlow!: CategoryFlow;
  @ApiProperty() requesterId!: string;
  @ApiProperty() requesterName!: string;
  @ApiProperty() offerCount!: number;
  @ApiProperty({ nullable: true, type: String }) pickupArea!: string | null;
  @ApiProperty({ nullable: true, type: String }) destinationArea!: string | null;
  @ApiProperty({ nullable: true, type: Date }) publishedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) expiresAt!: Date | null;
  @ApiProperty({ type: Date }) createdAt!: Date;
}

export class AdminCancelErrandDto extends AdminActionDto {}

export class AdminExtendErrandDto extends AdminActionDto {
  @ApiProperty({ minimum: 1, maximum: 168 }) @Type(() => Number) @IsInt() @Min(1) @Max(168) hours!: number;
}

export class AdminLegalHoldDto extends AdminActionDto {
  @ApiProperty({ description: 'true keeps the errand and its chat out of retention until lifted; false lifts the hold.' })
  @IsBoolean()
  hold!: boolean;
}

export class AdminTransitionDto extends AdminActionDto {
  @ApiProperty({ enum: ErrandStatus, description: 'The status to move to. Only moves the state machine allows an admin are accepted.' })
  @IsEnum(ErrandStatus)
  to!: ErrandStatus;
}

export class AdminAssignmentListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() errandId?: string;
  @ApiPropertyOptional({ enum: AssignmentStatus }) @IsOptional() @IsEnum(AssignmentStatus) status?: AssignmentStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() runnerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() requesterId?: string;
  @ApiPropertyOptional({ description: 'The errand title.', maxLength: 80 }) @IsOptional() @IsString() @MaxLength(80) q?: string;
}

export class AdminAssignmentRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() errandId!: string;
  @ApiProperty() errandTitle!: string;
  @ApiProperty({ enum: CategoryFlow }) categoryFlow!: CategoryFlow;
  @ApiProperty({ enum: AssignmentStatus }) status!: AssignmentStatus;
  @ApiProperty({ enum: ErrandStatus }) errandStatus!: ErrandStatus;
  @ApiProperty() requesterId!: string;
  @ApiProperty() runnerId!: string;
  @ApiProperty() runnerName!: string;
  @ApiProperty() agreedAmountMinor!: number;
  @ApiProperty({ type: Date }) selectedAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) acceptedAt!: Date | null;
  @ApiProperty({ type: Date }) createdAt!: Date;
}

// ---- Service ----

@Injectable()
export class AdminErrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pager: AdminPager,
  ) {}

  async search(options: { q?: string; status?: ErrandStatus; requesterId?: string; cursor?: string; limit?: number }): Promise<Paginated<AdminErrandRowDto>> {
    const limit = options.limit ?? 20;
    const after = this.pager.after(options.cursor);
    const conditions: Prisma.Sql[] = [Prisma.sql`e.deleted_at IS NULL`];
    if (options.status) conditions.push(Prisma.sql`e.status = ${options.status}::"ErrandStatus"`);
    if (options.requesterId) conditions.push(Prisma.sql`e.requester_id = ${options.requesterId}::uuid`);
    const term = options.q?.trim();
    if (term) {
      const like = likePattern(term);
      const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term);
      conditions.push(
        Prisma.sql`(e.title ILIKE ${like} OR e.description ILIKE ${like} OR u.name ILIKE ${like}
          ${isId ? Prisma.sql`OR e.id = ${term}::uuid` : Prisma.empty})`,
      );
    }
    if (after) conditions.push(Prisma.sql`(e.created_at, e.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; title: string; status: ErrandStatus; category: string; category_flow: CategoryFlow; requester_id: string; requester_name: string;
        offer_count: number; pickup_area: string | null; destination_area: string | null; published_at: Date | null;
        expires_at: Date | null; created_at: Date;
      }>
    >`
      SELECT e.id::text AS id, e.title, e.status, c.name AS category, c.flow AS category_flow, e.requester_id::text AS requester_id, u.name AS requester_name,
             e.offer_count, e.published_at, e.expires_at, e.created_at,
             (SELECT l.area FROM errand_locations l WHERE l.errand_id = e.id AND l.type = 'ERRAND_PICKUP'::"LocationType" AND l.deleted_at IS NULL LIMIT 1) AS pickup_area,
             (SELECT l.area FROM errand_locations l WHERE l.errand_id = e.id AND l.type = 'ERRAND_DESTINATION'::"LocationType" AND l.deleted_at IS NULL LIMIT 1) AS destination_area
      FROM errands e JOIN users u ON u.id = e.requester_id JOIN categories c ON c.id = e.category_id
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ${limit + 1}
    `;
    return this.pager.page(
      rows.map((r) => ({ ...r, createdAt: r.created_at })),
      limit,
      (r): AdminErrandRowDto => ({
        id: r.id, title: r.title, status: r.status, category: r.category, categoryFlow: r.category_flow, requesterId: r.requester_id, requesterName: r.requester_name,
        offerCount: r.offer_count, pickupArea: r.pickup_area, destinationArea: r.destination_area, publishedAt: r.published_at,
        expiresAt: r.expires_at, createdAt: r.created_at,
      }),
    );
  }

  async detail(errandId: string, locateConversation = false): Promise<Record<string, unknown>> {
    const errand = await this.prisma.errand.findFirst({
      where: { id: errandId },
      include: { category: true, requester: { select: { id: true, name: true } } },
    });
    if (!errand) throw DomainException.of(RESOURCE_NOT_FOUND);
    const [locations, assignment, cases] = await Promise.all([
      this.prisma.$queryRaw<Array<{ type: string; area: string; lga: string | null; state: string | null }>>`
        SELECT type::text AS type, area, lga, state FROM errand_locations WHERE errand_id = ${errandId}::uuid AND deleted_at IS NULL
      `,
      this.prisma.assignment.findFirst({
        where: { errandId, status: { in: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'COMPLETED'] } },
        orderBy: { createdAt: 'desc' },
        include: { runner: { select: { id: true, name: true } } },
      }),
      this.prisma.$queryRaw<Array<{ reports: number; disputes: number; problems: number }>>`
        SELECT (SELECT count(*)::int FROM reports WHERE errand_id = ${errandId}::uuid AND deleted_at IS NULL) AS reports,
               (SELECT count(*)::int FROM disputes WHERE errand_id = ${errandId}::uuid AND deleted_at IS NULL) AS disputes,
               (SELECT count(*)::int FROM execution_problems p JOIN assignments a ON a.id = p.assignment_id
                  WHERE a.errand_id = ${errandId}::uuid AND p.deleted_at IS NULL) AS problems
      `,
    ]);
    return {
      id: errand.id,
      title: errand.title,
      description: errand.description,
      status: errand.status,
      version: errand.version,
      category: { id: errand.category.id, key: errand.category.key, name: errand.category.name, flow: errand.category.flow },
      ...(locateConversation ? { conversationId: assignment ? await this.conversationId(errandId, assignment.runnerId) : null } : {}),
      requester: errand.requester,
      priority: errand.priority,
      timeMode: errand.timeMode,
      scheduledAt: errand.scheduledAt,
      suggestedBudgetMinor: errand.suggestedBudgetMinor === null ? null : Number(errand.suggestedBudgetMinor),
      offerCount: errand.offerCount,
      publishedAt: errand.publishedAt,
      expiresAt: errand.expiresAt,
      extendedAt: errand.extendedAt,
      cancelledAt: errand.cancelledAt,
      cancellationReason: errand.cancellationReason,
      cancellationNote: errand.cancellationNote,
      completedAt: errand.completedAt,
      createdAt: errand.createdAt,
      locations,
      assignment: assignment
        ? {
            id: assignment.id,
            status: assignment.status,
            runner: assignment.runner,
            agreedAmountMinor: Number(assignment.agreedAmountMinor),
            acceptedAt: assignment.acceptedAt,
          }
        : null,
      cases: cases[0],
    };
  }

  /** Status changes, execution steps and negotiation events, oldest first. */
  async timeline(errandId: string): Promise<Array<Record<string, unknown>>> {
    const exists = await this.prisma.errand.findFirst({ where: { id: errandId }, select: { id: true } });
    if (!exists) throw DomainException.of(RESOURCE_NOT_FOUND);
    const rows = await this.prisma.$queryRaw<Array<{ at: Date; source: string; type: string; actor_type: string | null; actor_id: string | null; detail: unknown }>>`
      SELECT created_at AS at, 'STATUS' AS source, to_status::text AS type, actor_type::text AS actor_type, actor_id::text AS actor_id,
             jsonb_build_object('from', from_status, 'reason', reason, 'version', version) AS detail
      FROM errand_status_history WHERE errand_id = ${errandId}::uuid
      UNION ALL
      SELECT created_at, 'EXECUTION', type::text, actor_type::text, actor_id::text, jsonb_build_object('note', note)
      FROM execution_events WHERE errand_id = ${errandId}::uuid
      UNION ALL
      SELECT created_at, 'NEGOTIATION', message_type::text, 'USER', actor_user_id::text,
             jsonb_build_object('offerId', offer_id, 'amountMinor', proposed_amount_minor::text, 'durationMinutes', proposed_duration_minutes)
      FROM negotiation_events WHERE errand_id = ${errandId}::uuid
      ORDER BY at ASC
    `;
    return rows.map((r) => ({ at: r.at, source: r.source, type: r.type, actorType: r.actor_type, actorId: r.actor_id, detail: r.detail }));
  }

  /** Exact addresses and points. Needs LOCATION_EXACT_VIEW; the controller records the view. */
  async exactLocations(errandId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ type: string; address_text: string | null; landmark: string | null; area: string; lat: number; lng: number }>
    >`
      SELECT type::text AS type, address_text, landmark, area, ST_Y(exact_point::geometry) AS lat, ST_X(exact_point::geometry) AS lng
      FROM errand_locations WHERE errand_id = ${errandId}::uuid AND deleted_at IS NULL
    `;
    return rows.map((r) => ({ type: r.type, addressText: r.address_text, landmark: r.landmark, area: r.area, lat: r.lat, lng: r.lng }));
  }

  async offersOf(errandId: string): Promise<Array<Record<string, unknown>>> {
    const exists = await this.prisma.errand.findFirst({ where: { id: errandId }, select: { id: true } });
    if (!exists) throw DomainException.of(RESOURCE_NOT_FOUND);
    const rows = await this.prisma.offer.findMany({
      where: { errandId, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { runner: { select: { id: true, name: true } } },
    });
    return rows.map((o) => ({
      id: o.id,
      runner: o.runner,
      amountMinor: Number(o.amountMinor),
      durationMinutes: o.durationMinutes,
      status: o.status,
      closeReason: o.closeReason,
      awaitingParty: o.awaitingParty,
      needsReconfirmation: o.needsReconfirmation,
      createdAt: o.createdAt,
    }));
  }

  async offerHistory(offerId: string): Promise<Record<string, unknown>> {
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId },
      include: { runner: { select: { id: true, name: true } }, errand: { select: { id: true, title: true, status: true } } },
    });
    if (!offer) throw DomainException.of(RESOURCE_NOT_FOUND);
    const events = await this.prisma.negotiationEvent.findMany({ where: { offerId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return {
      id: offer.id,
      errand: offer.errand,
      runner: offer.runner,
      amountMinor: Number(offer.amountMinor),
      durationMinutes: offer.durationMinutes,
      status: offer.status,
      closeReason: offer.closeReason,
      version: offer.version,
      createdAt: offer.createdAt,
      history: events.map((e) => ({
        at: e.createdAt,
        type: e.messageType,
        actorUserId: e.actorUserId,
        amountMinor: e.proposedAmountMinor === null ? null : Number(e.proposedAmountMinor),
        durationMinutes: e.proposedDurationMinutes,
        message: e.message,
      })),
    };
  }

  async assignments(options: {
    status?: AssignmentStatus; errandId?: string; runnerId?: string; requesterId?: string; q?: string; cursor?: string; limit?: number;
  }): Promise<Paginated<AdminAssignmentRowDto>> {
    const limit = options.limit ?? 20;
    const after = this.pager.after(options.cursor);
    const conditions: Prisma.Sql[] = [Prisma.sql`a.deleted_at IS NULL`];
    if (options.errandId) conditions.push(Prisma.sql`a.errand_id = ${options.errandId}::uuid`);
    if (options.status) conditions.push(Prisma.sql`a.status = ${options.status}::"AssignmentStatus"`);
    if (options.runnerId) conditions.push(Prisma.sql`a.runner_id = ${options.runnerId}::uuid`);
    if (options.requesterId) conditions.push(Prisma.sql`a.requester_id = ${options.requesterId}::uuid`);
    if (options.q?.trim()) conditions.push(Prisma.sql`e.title ILIKE ${likePattern(options.q)}`);
    if (after) conditions.push(Prisma.sql`(a.created_at, a.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; errand_id: string; title: string; category_flow: CategoryFlow; status: AssignmentStatus; errand_status: ErrandStatus; requester_id: string;
        runner_id: string; runner_name: string; agreed: bigint; selected_at: Date; accepted_at: Date | null; created_at: Date;
      }>
    >`
      SELECT a.id::text AS id, a.errand_id::text AS errand_id, e.title, c.flow AS category_flow, a.status, e.status AS errand_status,
             a.requester_id::text AS requester_id, a.runner_id::text AS runner_id, u.name AS runner_name,
             a.agreed_amount_minor AS agreed, a.selected_at, a.accepted_at, a.created_at
      FROM assignments a JOIN errands e ON e.id = a.errand_id JOIN categories c ON c.id = e.category_id JOIN users u ON u.id = a.runner_id
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limit + 1}
    `;
    return this.pager.page(
      rows.map((r) => ({ ...r, createdAt: r.created_at })),
      limit,
      (r): AdminAssignmentRowDto => ({
        id: r.id, errandId: r.errand_id, errandTitle: r.title, categoryFlow: r.category_flow, status: r.status, errandStatus: r.errand_status,
        requesterId: r.requester_id, runnerId: r.runner_id, runnerName: r.runner_name, agreedAmountMinor: Number(r.agreed),
        selectedAt: r.selected_at, acceptedAt: r.accepted_at, createdAt: r.created_at,
      }),
    );
  }

  async assignmentDetail(assignmentId: string, locateConversation = false): Promise<Record<string, unknown>> {
    const a = await this.prisma.assignment.findFirst({
      where: { id: assignmentId },
      include: {
        errand: { select: { id: true, title: true, status: true, category: { select: { flow: true } } } },
        runner: { select: { id: true, name: true } },
        requester: { select: { id: true, name: true } },
        paymentAgreement: true,
      },
    });
    if (!a) throw DomainException.of(RESOURCE_NOT_FOUND);
    const [events, problems, changes] = await Promise.all([
      this.prisma.executionEvent.findMany({ where: { assignmentId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      this.prisma.executionProblem.findMany({ where: { assignmentId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
      this.prisma.changeRequest.findMany({ where: { assignmentId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    ]);
    return {
      id: a.id,
      status: a.status,
      errand: a.errand,
      ...(locateConversation ? { conversationId: await this.conversationId(a.errandId, a.runnerId) } : {}),
      runner: a.runner,
      requester: a.requester,
      agreedAmountMinor: Number(a.agreedAmountMinor),
      selectedAt: a.selectedAt,
      acceptanceDeadline: a.acceptanceDeadline,
      acceptedAt: a.acceptedAt,
      cancelledAt: a.cancelledAt,
      cancellationReason: a.cancellationReason,
      cancelledStage: a.cancelledStage,
      paymentAgreement: a.paymentAgreement
        ? { method: a.paymentAgreement.paymentMethod, timing: a.paymentAgreement.paymentTiming, confirmedByRequester: a.paymentAgreement.confirmedByRequesterAt !== null, confirmedByRunner: a.paymentAgreement.confirmedByRunnerAt !== null }
        : null,
      events: events.map((e) => ({ at: e.createdAt, type: e.type, actorType: e.actorType, note: e.note })),
      problems: problems.map((p) => ({ id: p.id, type: p.type, status: p.status, note: p.note, createdAt: p.createdAt, resolvedAt: p.resolvedAt })),
      changeRequests: changes.map((c) => ({ id: c.id, type: c.type, status: c.status, expiresAt: c.expiresAt, createdAt: c.createdAt })),
    };
  }

  private async conversationId(errandId: string, runnerId: string): Promise<string | null> {
    const conversation = await this.prisma.conversation.findFirst({ where: { errandId, runnerId, deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    return conversation?.id ?? null;
  }

  async errandIdOfAssignment(assignmentId: string): Promise<{ errandId: string; requesterId: string }> {
    const a = await this.prisma.assignment.findFirst({ where: { id: assignmentId }, select: { errandId: true, requesterId: true } });
    if (!a) throw DomainException.of(RESOURCE_NOT_FOUND);
    return a;
  }

  /** An errand that was never published has nothing to reopen to: it was only ever a draft. */
  async assertWasPublished(errandId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
      SELECT (published_at IS NOT NULL AND expires_at IS NOT NULL AND time_mode IS NOT NULL AND prohibited_items_confirmed_at IS NOT NULL) AS ok
      FROM errands WHERE id = ${errandId}::uuid AND deleted_at IS NULL
    `;
    if (!rows[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
    if (!rows[0].ok) {
      throw DomainException.of(ERRAND_INVALID_STATE, { message: 'This errand was never published, so it cannot be reopened.', details: { reason: 'NEVER_PUBLISHED' } });
    }
  }

  /** A legal hold keeps the chat of an errand out of retention (Backend PRD 29). Returns the new state. */
  async setLegalHold(errandId: string, hold: boolean): Promise<{ errandId: string; legalHold: boolean }> {
    const changed = await this.prisma.errand.updateMany({ where: { id: errandId, deletedAt: null }, data: { legalHold: hold } });
    if (changed.count === 0) throw DomainException.of(RESOURCE_NOT_FOUND);
    return { errandId, legalHold: hold };
  }

  async requesterOf(errandId: string): Promise<string> {
    const e = await this.prisma.errand.findFirst({ where: { id: errandId }, select: { requesterId: true } });
    if (!e) throw DomainException.of(RESOURCE_NOT_FOUND);
    return e.requesterId;
  }
}

// ---- Controller ----

/** Errands, offers and assignments (Backend PRD 24.4 areas 3 to 5). Every status change goes through the state machine as ADMIN. */
@ApiTags('Admin errands')
@Controller('admin')
export class AdminErrandsController {
  constructor(
    private readonly service: AdminErrandsService,
    private readonly prisma: PrismaService,
    private readonly state: ErrandStateService,
    private readonly lifecycle: ErrandLifecycleService,
    private readonly offers: OfferService,
    private readonly enforcement: EnforcementService,
    private readonly actions: AdminActionService,
    private readonly sensitive: SensitiveAccessService,
  ) {}

  // ---- Errands ----

  @Get('errands')
  @AdminAuth('ERRANDS_VIEW')
  @ApiEnveloped(AdminErrandRowDto, { isArray: true })
  @ApiErrors(400)
  search(@Query() query: AdminErrandListQueryDto) {
    return this.service.search(query);
  }

  @Get('errands/:id')
  @AdminAuth('ERRANDS_VIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(404)
  detail(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id, admin.permissions.includes('CHAT_SENSITIVE_VIEW'));
  }

  @Get('errands/:id/timeline')
  @AdminAuth('ERRANDS_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  @ApiErrors(404)
  timeline(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.timeline(id);
  }

  /** Exact pickup and drop-off addresses. Needs LOCATION_EXACT_VIEW and is audited. */
  @Get('errands/:id/locations')
  @AdminAuth('ERRANDS_VIEW', 'LOCATION_EXACT_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  @ApiErrors(404)
  async locations(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @ReqCtx() ctx: RequestContext) {
    await this.service.requesterOf(id);
    await this.sensitive.record({
      admin,
      permission: 'LOCATION_EXACT_VIEW',
      resource: 'errand.exact_location',
      entityType: 'errand',
      entityId: id,
      ctx,
    });
    return this.service.exactLocations(id);
  }

  @Post('errands/:id/cancel')
  @HttpCode(200)
  @AdminAuth('ERRANDS_MODERATE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  cancel(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminCancelErrandDto, @ReqCtx() ctx: RequestContext) {
    return this.transition(admin, id, 'CANCELLED', dto, ctx, 'errand.force_cancel');
  }

  @Post('errands/:id/expire')
  @HttpCode(200)
  @AdminAuth('ERRANDS_MODERATE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  expire(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.transition(admin, id, 'EXPIRED', dto, ctx, 'errand.force_expire');
  }

  @Post('errands/:id/reopen')
  @HttpCode(200)
  @AdminAuth('ERRANDS_MODERATE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async reopen(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    await this.service.assertWasPublished(id);
    return this.transition(admin, id, 'OPEN', dto, ctx, 'errand.reopen');
  }

  /** Any other move the state machine allows an admin (for example, release an accepted errand back to open). */
  @Post('errands/:id/transition')
  @HttpCode(200)
  @AdminAuth('ERRANDS_MODERATE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  force(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminTransitionDto, @ReqCtx() ctx: RequestContext) {
    return this.transition(admin, id, dto.to, dto, ctx, 'errand.force_transition');
  }

  @Post('errands/:id/extend')
  @HttpCode(200)
  @AdminAuth('ERRANDS_MODERATE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  extend(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminExtendErrandDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'errand.extend',
      entityType: 'errand',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { hours: dto.hours },
      execute: () => this.lifecycle.adminExtend(id, dto.hours, admin.adminId),
    });
  }

  /** Place or lift a legal hold: while held, the errand's chat is not redacted by retention. */
  @Post('errands/:id/legal-hold')
  @HttpCode(200)
  @AdminAuth('ERRANDS_MODERATE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  legalHold(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminLegalHoldDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: dto.hold ? 'errand.legal_hold_set' : 'errand.legal_hold_lifted',
      entityType: 'errand',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { hold: dto.hold },
      execute: () => this.service.setLegalHold(id, dto.hold),
    });
  }

  /** Take an errand down as content: it is cancelled through the state machine, so offers and assignments follow. */
  @Post('errands/:id/remove-content')
  @HttpCode(200)
  @AdminAuth('ERRANDS_MODERATE', 'ENFORCEMENT_APPLY')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async removeContent(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    const requesterId = await this.service.requesterOf(id);
    return this.actions.run({
      admin,
      action: 'errand.remove_content',
      entityType: 'errand',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: async () => {
        const action = await this.enforcement.adminApply(
          { userId: requesterId, type: 'CONTENT_REMOVAL', reason: dto.reasonText ?? dto.reasonCode, content: { type: 'ERRAND', id } },
          { adminId: admin.adminId },
        );
        return { removed: true, enforcementActionId: action.id };
      },
    });
  }

  // ---- Offers ----

  @Get('errands/:id/offers')
  @AdminAuth('ERRANDS_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  @ApiErrors(404)
  offersOf(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.offersOf(id);
  }

  @Get('offers/:id')
  @AdminAuth('ERRANDS_VIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(404)
  offer(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.offerHistory(id);
  }

  @Post('offers/:id/close')
  @HttpCode(200)
  @AdminAuth('ERRANDS_MODERATE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  closeOffer(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'offer.close',
      entityType: 'offer',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: async () => {
        const offer = await this.offers.adminClose(id, admin.adminId, dto.reasonText ?? dto.reasonCode);
        return { id: offer.id, status: offer.status, closeReason: offer.closeReason };
      },
    });
  }

  // ---- Assignments ----

  @Get('assignments')
  @AdminAuth('ERRANDS_VIEW')
  @ApiEnveloped(AdminAssignmentRowDto, { isArray: true })
  @ApiErrors(400)
  assignments(@Query() query: AdminAssignmentListQueryDto) {
    return this.service.assignments(query);
  }

  @Get('assignments/:id')
  @AdminAuth('ERRANDS_VIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(404)
  assignment(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.assignmentDetail(id, admin.permissions.includes('CHAT_SENSITIVE_VIEW'));
  }

  /** Cancel the assignment's errand as an admin. From pickup on, the state machine requires a dispute instead. */
  @Post('assignments/:id/cancel')
  @HttpCode(200)
  @AdminAuth('ERRANDS_MODERATE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async cancelAssignment(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminCancelErrandDto, @ReqCtx() ctx: RequestContext) {
    const { errandId } = await this.service.errandIdOfAssignment(id);
    return this.transition(admin, errandId, 'CANCELLED', dto, ctx, 'assignment.cancel');
  }

  /** Unstick an accepted assignment: the runner is released and the errand returns to open (a new deadline is counted). */
  @Post('assignments/:id/release')
  @HttpCode(200)
  @AdminAuth('ERRANDS_MODERATE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async release(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    const { errandId } = await this.service.errandIdOfAssignment(id);
    return this.transition(admin, errandId, 'OPEN', dto, ctx, 'assignment.release', ['ACCEPTED']);
  }

  // ---- internals ----

  /** One errand transition with actor ADMIN, in its own transaction, audited with the reason. */
  private transition(
    admin: AuthenticatedAdmin,
    errandId: string,
    to: ErrandStatus,
    dto: AdminActionDto,
    ctx: RequestContext,
    action: string,
    expectedFrom?: ErrandStatus[],
  ) {
    return this.actions.run({
      admin,
      action,
      entityType: 'errand',
      entityId: errandId,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { to },
      execute: () =>
        this.prisma.$transaction((tx) =>
          this.state.transition(tx, {
            errandId,
            to,
            ...(expectedFrom ? { expectedFrom } : {}),
            actor: { type: 'ADMIN', id: admin.adminId },
            reason: dto.reasonText ?? dto.reasonCode,
            ...(to === 'CANCELLED' ? { cancellation: { reason: 'ADMIN_CANCELLED' as const, note: dto.reasonText } } : {}),
          }),
        ),
    });
  }
}

import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { BadgeType, BlocklistType, EnforcementActionType, Prisma, RestrictionStatus, UserRestrictionType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PrismaService } from '../../database/prisma.service.js';
import { Paginated } from '../../common/pagination/paginated.js';
import { PaginationQueryDto } from '../../common/pagination/pagination.dto.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../../common/constants/error-codes.js';
import { ApiEnveloped, ApiErrors } from '../../common/api/api-docs.js';
import { ReqCtx } from '../../auth/decorators/request-context.decorator.js';
import type { RequestContext } from '../../auth/auth-audit.service.js';
import { BlocklistService } from '../../auth/blocklist.service.js';
import { AdminAuth, CurrentAdmin, type AuthenticatedAdmin } from '../../admin/decorators/admin-auth.decorator.js';
import { AdminActionService } from '../../admin/framework/admin-action.service.js';
import { AdminActionDto } from '../../admin/framework/admin-reasons.js';
import { ApprovalService, type ApprovalView } from '../../admin/framework/approval.service.js';
import { ApprovalDto } from '../../admin/framework/approval.controller.js';
import { EnforcementService, toActionDto } from '../../enforcement/enforcement.service.js';
import { BadgeService } from '../../badges/badge.service.js';
import { AdminPager } from '../common/admin-page.js';
import { AnyObjectDto } from '../common/any-object.dto.js';

// ---- DTOs ----

export class EnforcementListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RestrictionStatus }) @IsOptional() @IsEnum(RestrictionStatus) status?: RestrictionStatus;
  @ApiPropertyOptional({ enum: EnforcementActionType }) @IsOptional() @IsEnum(EnforcementActionType) type?: EnforcementActionType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;
}

export class ContentTargetDto {
  @ApiProperty({ enum: ['RATING', 'MESSAGE', 'ERRAND'] }) @IsIn(['RATING', 'MESSAGE', 'ERRAND']) type!: 'RATING' | 'MESSAGE' | 'ERRAND';
  @ApiProperty() @IsUUID() id!: string;
}

export class ApplyEnforcementDto extends AdminActionDto {
  @ApiProperty() @IsUUID() userId!: string;
  @ApiProperty({ enum: EnforcementActionType, description: 'PERMANENT_SUSPENSION is requested here and applied when a second admin approves.' })
  @IsEnum(EnforcementActionType)
  type!: EnforcementActionType;

  @ApiPropertyOptional({ description: 'Report, dispute or reliability event ids the action rests on.' })
  @IsOptional() @IsString() @MaxLength(200) caseRef?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 365 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) durationDays?: number;

  @ApiPropertyOptional({ enum: UserRestrictionType, isArray: true })
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsEnum(UserRestrictionType, { each: true }) restrictionTypes?: UserRestrictionType[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() safetyCritical?: boolean;
  @ApiPropertyOptional({ enum: BadgeType }) @IsOptional() @IsEnum(BadgeType) badge?: BadgeType;

  @ApiPropertyOptional({ type: ContentTargetDto })
  @IsOptional() @ValidateNested() @Type(() => ContentTargetDto) content?: ContentTargetDto;

  @ApiPropertyOptional({ description: 'The review case this action answers.' })
  @IsOptional() @IsUUID() reviewId?: string;

  @ApiPropertyOptional({ type: String, isArray: true, description: 'Reliability event ids the action rests on.' })
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID(undefined, { each: true }) causeEventIds?: string[];
}

export class DecideAppealDto extends AdminActionDto {
  @ApiProperty({ enum: ['UPHELD', 'REVOKED'], description: 'UPHELD leaves the action in force. REVOKED lifts it.' })
  @IsIn(['UPHELD', 'REVOKED'])
  outcome!: 'UPHELD' | 'REVOKED';

  @ApiProperty({ description: 'What the user is told.' })
  @IsString() @MinLength(1) @MaxLength(500)
  note!: string;
}

export class AdminEnforcementRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() userName!: string;
  @ApiProperty({ enum: EnforcementActionType }) type!: EnforcementActionType;
  @ApiProperty({ enum: RestrictionStatus }) status!: RestrictionStatus;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: ['LADDER', 'SEVERE_EVENT', 'ADMIN'] }) trigger!: string;
  @ApiProperty({ nullable: true, type: String }) caseRef!: string | null;
  @ApiProperty({ type: Date }) startsAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) endsAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) appealRequestedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) appealNote!: string | null;
  @ApiProperty({ nullable: true, type: Date }) appealDueAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) appealOutcome!: string | null;
  @ApiProperty({ type: Date }) createdAt!: Date;
}

export class EnforcementReviewRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() userName!: string;
  @ApiProperty({ enum: ['LADDER_ADMIN_REVIEW', 'SEVERE_EVENT'] }) trigger!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ nullable: true, type: Number }) points!: number | null;
  @ApiProperty({ nullable: true, type: String }) caseRef!: string | null;
  @ApiProperty({ enum: ['OPEN', 'ACTIONED', 'DISMISSED'] }) status!: string;
  @ApiProperty({ type: Date }) createdAt!: Date;
}

export class BlocklistQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BlocklistType }) @IsOptional() @IsEnum(BlocklistType) type?: BlocklistType;
}

export class BlockValueDto extends AdminActionDto {
  @ApiProperty({ enum: ['PHONE', 'EMAIL'] }) @IsIn(['PHONE', 'EMAIL']) type!: 'PHONE' | 'EMAIL';
  @ApiProperty({ description: 'A phone number (any Nigerian format) or an email address.' })
  @IsString() @MinLength(5) @MaxLength(255)
  value!: string;
}

export class BlocklistEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: BlocklistType }) type!: BlocklistType;
  @ApiProperty() reason!: string;
  @ApiProperty({ nullable: true, type: String }) sourceEnforcementId!: string | null;
  @ApiProperty({ nullable: true, type: Date }) expiresAt!: Date | null;
  @ApiProperty({ type: Date }) createdAt!: Date;
}

export class BadgeRowDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: BadgeType }) badge!: BadgeType;
  @ApiProperty({ type: Date }) awardedAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) revokedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) revokedReason!: string | null;
  @ApiProperty({ type: Object }) reasonSnapshot!: Record<string, unknown>;
}

// ---- Service ----

@Injectable()
export class AdminEnforcementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pager: AdminPager,
    private readonly blocklist: BlocklistService,
  ) {}

  async list(options: {
    status?: RestrictionStatus;
    type?: EnforcementActionType;
    userId?: string;
    appealsOnly?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<Paginated<AdminEnforcementRowDto>> {
    const limit = options.limit ?? 20;
    const after = this.pager.after(options.cursor);
    const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (options.status) conditions.push(Prisma.sql`e.status = ${options.status}::"RestrictionStatus"`);
    if (options.type) conditions.push(Prisma.sql`e.type = ${options.type}::"EnforcementActionType"`);
    if (options.userId) conditions.push(Prisma.sql`e.user_id = ${options.userId}::uuid`);
    if (options.appealsOnly) conditions.push(Prisma.sql`e.appeal_requested_at IS NOT NULL AND e.appeal_outcome IS NULL`);
    if (after) conditions.push(Prisma.sql`(e.created_at, e.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; user_id: string; user_name: string; type: EnforcementActionType; status: RestrictionStatus; reason: string;
        trigger: string; case_ref: string | null; starts_at: Date; ends_at: Date | null; appeal_requested_at: Date | null;
        appeal_note: string | null; appeal_due_at: Date | null; appeal_outcome: string | null; created_at: Date;
      }>
    >`
      SELECT e.id::text AS id, e.user_id::text AS user_id, u.name AS user_name, e.type, e.status, e.reason, e.trigger, e.case_ref,
             e.starts_at, e.ends_at, e.appeal_requested_at, e.appeal_note, e.appeal_due_at, e.appeal_outcome, e.created_at
      FROM enforcement_actions e JOIN users u ON u.id = e.user_id
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY ${options.appealsOnly ? Prisma.sql`e.appeal_due_at ASC NULLS LAST, e.id ASC` : Prisma.sql`e.created_at DESC, e.id DESC`}
      LIMIT ${limit + 1}
    `;
    return this.pager.page(
      rows.map((r) => ({ ...r, createdAt: r.created_at })),
      limit,
      (r): AdminEnforcementRowDto => ({
        id: r.id, userId: r.user_id, userName: r.user_name, type: r.type, status: r.status, reason: r.reason, trigger: r.trigger,
        caseRef: r.case_ref, startsAt: r.starts_at, endsAt: r.ends_at, appealRequestedAt: r.appeal_requested_at,
        appealNote: r.appeal_note, appealDueAt: r.appeal_due_at, appealOutcome: r.appeal_outcome, createdAt: r.created_at,
      }),
    );
  }

  async reviews(options: { status?: string; cursor?: string; limit?: number }): Promise<Paginated<EnforcementReviewRowDto>> {
    const limit = options.limit ?? 20;
    const after = this.pager.after(options.cursor);
    const status = options.status ?? 'OPEN';
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; user_id: string; user_name: string; trigger: string; reason: string; points: number | null; case_ref: string | null; status: string; created_at: Date }>
    >`
      SELECT r.id::text AS id, r.user_id::text AS user_id, u.name AS user_name, r.trigger, r.reason, r.points, r.case_ref, r.status, r.created_at
      FROM enforcement_reviews r JOIN users u ON u.id = r.user_id
      WHERE r.deleted_at IS NULL AND r.status = ${status}
        AND (${after?.createdAt ?? null}::timestamptz IS NULL OR (r.created_at, r.id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${limit + 1}
    `;
    return this.pager.page(
      rows.map((r) => ({ ...r, createdAt: r.created_at })),
      limit,
      (r): EnforcementReviewRowDto => ({
        id: r.id, userId: r.user_id, userName: r.user_name, trigger: r.trigger, reason: r.reason, points: r.points,
        caseRef: r.case_ref, status: r.status, createdAt: r.created_at,
      }),
    );
  }

  async blocklistEntries(options: { type?: BlocklistType; cursor?: string; limit?: number }): Promise<Paginated<BlocklistEntryDto>> {
    const limit = options.limit ?? 20;
    const after = this.pager.after(options.cursor);
    const rows = await this.prisma.blocklistEntry.findMany({
      where: {
        deletedAt: null,
        ...(options.type ? { type: options.type } : {}),
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return this.pager.page(rows, limit, (r): BlocklistEntryDto => ({
      id: r.id, type: r.type, reason: r.reason, sourceEnforcementId: r.sourceEnforcementId, expiresAt: r.expiresAt, createdAt: r.createdAt,
    }));
  }

  async block(type: 'PHONE' | 'EMAIL', value: string, reason: string): Promise<void> {
    if (type === 'PHONE') {
      const { normalizePhone, isValidNigerianPhone } = await import('../../common/utils/phone.helper.js');
      if (!isValidNigerianPhone(value)) throw DomainException.of(VALIDATION_ERROR, { message: 'Enter a valid Nigerian phone number.', details: { field: 'value' } });
      await this.blocklist.blockPhone(normalizePhone(value), reason);
    } else {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw DomainException.of(VALIDATION_ERROR, { message: 'Enter a valid email address.', details: { field: 'value' } });
      await this.blocklist.blockEmail(value, reason);
    }
  }

  async unblock(entryId: string): Promise<void> {
    if (!(await this.blocklist.unblockById(entryId))) throw DomainException.of(RESOURCE_NOT_FOUND);
  }

  async badges(userId: string): Promise<BadgeRowDto[]> {
    const user = await this.prisma.user.findFirst({ where: { id: userId }, select: { id: true } });
    if (!user) throw DomainException.of(RESOURCE_NOT_FOUND);
    const rows = await this.prisma.userBadge.findMany({ where: { userId }, orderBy: [{ awardedAt: 'desc' }] });
    return rows.map((r) => ({
      id: r.id, badge: r.badge, awardedAt: r.awardedAt, revokedAt: r.revokedAt, revokedReason: r.revokedReason,
      reasonSnapshot: r.reasonSnapshot as Record<string, unknown>,
    }));
  }
}

// ---- Controller ----

/** Enforcement, appeals, review cases, the blocklist and badges (Backend PRD 24.4 areas 8 and 9). */
@ApiTags('Admin enforcement')
@Controller('admin')
export class AdminEnforcementController {
  constructor(
    private readonly service: AdminEnforcementService,
    private readonly enforcement: EnforcementService,
    private readonly approvals: ApprovalService,
    private readonly actions: AdminActionService,
    private readonly badgeService: BadgeService,
  ) {}

  @Get('enforcement')
  @AdminAuth('USERS_VIEW')
  @ApiEnveloped(AdminEnforcementRowDto, { isArray: true })
  @ApiErrors(400)
  list(@Query() query: EnforcementListQueryDto) {
    return this.service.list(query);
  }

  /** Appeals waiting for an answer, the closest deadline first. */
  @Get('enforcement/appeals')
  @AdminAuth('USERS_VIEW')
  @ApiEnveloped(AdminEnforcementRowDto, { isArray: true })
  appeals(@Query() query: PaginationQueryDto) {
    return this.service.list({ appealsOnly: true, cursor: query.cursor, limit: query.limit });
  }

  /** Open review cases (the ladder reached admin review, or a severe event skipped it). */
  @Get('enforcement/reviews')
  @AdminAuth('USERS_VIEW')
  @ApiEnveloped(EnforcementReviewRowDto, { isArray: true })
  reviews(@Query() query: PaginationQueryDto) {
    return this.service.reviews({ cursor: query.cursor, limit: query.limit });
  }

  /**
   * Apply an action now. A PERMANENT_SUSPENSION is not applied here: it becomes a four-eyes request
   * (the answer is the approval) and runs when a second admin approves.
   */
  @Post('enforcement')
  @HttpCode(200)
  @AdminAuth('ENFORCEMENT_APPLY')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async apply(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: ApplyEnforcementDto, @ReqCtx() ctx: RequestContext): Promise<unknown> {
    if (dto.type === 'PERMANENT_SUSPENSION') {
      const approval: ApprovalView = await this.approvals.request(
        admin,
        {
          kind: 'PERMANENT_SUSPENSION',
          reason: { code: dto.reasonCode, text: dto.reasonText },
          summary: `Permanently suspend user ${dto.userId}`,
          targetType: 'user',
          targetId: dto.userId,
          payload: { userId: dto.userId, caseRef: dto.caseRef, reviewId: dto.reviewId, causeEventIds: dto.causeEventIds },
        },
        ctx,
      );
      return { approvalRequired: true, approval };
    }
    const action = await this.actions.run({
      admin,
      action: 'enforcement.apply',
      entityType: 'user',
      entityId: dto.userId,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { type: dto.type, durationDays: dto.durationDays },
      execute: () =>
        this.enforcement.adminApply(
          {
            userId: dto.userId,
            type: dto.type,
            reason: dto.reasonText ?? dto.reasonCode,
            caseRef: dto.caseRef,
            durationDays: dto.durationDays,
            restrictionTypes: dto.restrictionTypes,
            safetyCritical: dto.safetyCritical,
            badge: dto.badge,
            content: dto.content,
            causeEventIds: dto.causeEventIds,
          },
          { adminId: admin.adminId, reviewId: dto.reviewId },
        ),
    });
    return { approvalRequired: false, action: toActionDto(action) };
  }

  @Post('enforcement/:id/revoke')
  @HttpCode(200)
  @AdminAuth('ENFORCEMENT_APPLY')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async revoke(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminActionDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    const action = await this.actions.run({
      admin,
      action: 'enforcement.revoke',
      entityType: 'enforcement_action',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.enforcement.adminRevoke(id, dto.reasonText ?? dto.reasonCode, { adminId: admin.adminId }),
    });
    return toActionDto(action);
  }

  @Post('enforcement/:id/appeal/decide')
  @HttpCode(200)
  @AdminAuth('ENFORCEMENT_APPLY')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async decideAppeal(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideAppealDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    const action = await this.actions.run({
      admin,
      action: 'enforcement.appeal_decide',
      entityType: 'enforcement_action',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { outcome: dto.outcome },
      execute: () => this.enforcement.adminDecideAppeal(id, dto.outcome, dto.note, { adminId: admin.adminId }),
    });
    return toActionDto(action);
  }

  @Post('enforcement/reviews/:id/dismiss')
  @HttpCode(200)
  @AdminAuth('ENFORCEMENT_APPLY')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async dismissReview(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminActionDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    await this.actions.run({
      admin,
      action: 'enforcement.review_dismiss',
      entityType: 'enforcement_review',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.enforcement.dismissReview(id, dto.reasonText ?? dto.reasonCode, { adminId: admin.adminId }),
    });
    return { id, dismissed: true };
  }

  // ---- Blocklist ----

  @Get('blocklist')
  @AdminAuth('BLOCKLIST_MANAGE')
  @ApiEnveloped(BlocklistEntryDto, { isArray: true })
  blocklist(@Query() query: BlocklistQueryDto) {
    return this.service.blocklistEntries(query);
  }

  @Post('blocklist')
  @HttpCode(200)
  @AdminAuth('BLOCKLIST_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403)
  async block(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: BlockValueDto, @ReqCtx() ctx: RequestContext) {
    await this.actions.run({
      admin,
      action: 'blocklist.add',
      entityType: 'blocklist',
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { type: dto.type },
      execute: () => this.service.block(dto.type, dto.value, dto.reasonText ?? dto.reasonCode),
    });
    return { blocked: true, type: dto.type };
  }

  @Delete('blocklist/:id')
  @HttpCode(200)
  @AdminAuth('BLOCKLIST_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  async unblock(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminActionDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    await this.actions.run({
      admin,
      action: 'blocklist.remove',
      entityType: 'blocklist_entry',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.service.unblock(id),
    });
    return { id, removed: true };
  }

  // ---- Badges ----

  /** Earned and revoked badges with the facts each rested on. Badges are derived, so there is no manual grant. */
  @Get('users/:id/badges')
  @AdminAuth('USERS_VIEW')
  @ApiEnveloped(BadgeRowDto, { isArray: true })
  @ApiErrors(403, 404)
  badges(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.badges(id);
  }

  /** Re-evaluate the user's badges from the source records now. */
  @Post('users/:id/badges/recompute')
  @HttpCode(200)
  @AdminAuth('USERS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  async recompute(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminActionDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    await this.service.badges(id);
    return this.actions.run({
      admin,
      action: 'badges.recompute',
      entityType: 'user',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.badgeService.recompute(id),
    });
  }
}

export { ApprovalDto };

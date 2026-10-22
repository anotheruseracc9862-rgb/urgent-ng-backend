import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Prisma, VerificationFailureReason, VerificationStatus } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
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
import { SensitiveAccessService } from '../../admin/framework/sensitive-access.service.js';
import { VerificationAdminService } from '../../verification/verification-admin.service.js';
import { VerificationService } from '../../verification/verification.service.js';
import { VerificationSubmissionDto } from '../../verification/verification.dto.js';
import { AdminPager } from '../common/admin-page.js';
import { AnyObjectDto } from '../common/any-object.dto.js';

export class VerificationQueueQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: VerificationStatus, default: 'REVIEW_REQUIRED' })
  @IsOptional()
  @IsEnum(VerificationStatus)
  status?: VerificationStatus;
}

export class VerificationRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() userName!: string;
  @ApiProperty({ enum: VerificationStatus }) status!: VerificationStatus;
  @ApiProperty({ enum: VerificationFailureReason, nullable: true }) failureReason!: VerificationFailureReason | null;
  @ApiProperty() attemptNumber!: number;
  @ApiProperty() provider!: string;
  @ApiProperty({ nullable: true, type: Number }) confidence!: number | null;
  @ApiProperty({ type: Object, nullable: true, description: 'Masked attributes from the provider. No NIN.' }) maskedAttributes!: Record<string, unknown> | null;
  @ApiProperty() hasSubmission!: boolean;
  @ApiProperty({ type: Date }) startedAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) completedAt!: Date | null;
}

export class RejectVerificationDto extends AdminActionDto {
  @ApiPropertyOptional({ enum: VerificationFailureReason })
  @IsOptional()
  @IsEnum(VerificationFailureReason)
  failureReason?: VerificationFailureReason;

  @ApiPropertyOptional({ description: 'Whether the attempt uses one of the runner\'s tries. Default true.' })
  @IsOptional()
  @IsBoolean()
  countsAgainstAllowance?: boolean;
}

@Injectable()
export class AdminVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pager: AdminPager,
  ) {}

  async queue(options: { status?: VerificationStatus; userId?: string; attemptId?: string; cursor?: string; limit?: number }): Promise<Paginated<VerificationRowDto>> {
    const limit = options.limit ?? 20;
    const after = this.pager.after(options.cursor);
    const status = options.userId || options.attemptId ? options.status : (options.status ?? 'REVIEW_REQUIRED');
    const conditions: Prisma.Sql[] = [Prisma.sql`a.deleted_at IS NULL`];
    if (status) conditions.push(Prisma.sql`a.status = ${status}::"VerificationStatus"`);
    if (options.userId) conditions.push(Prisma.sql`a.user_id = ${options.userId}::uuid`);
    if (options.attemptId) conditions.push(Prisma.sql`a.id = ${options.attemptId}::uuid`);
    if (after) conditions.push(Prisma.sql`(a.created_at, a.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        user_id: string;
        user_name: string;
        status: VerificationStatus;
        failure_reason: VerificationFailureReason | null;
        attempt_number: number;
        provider: string;
        confidence: string | null;
        masked_attributes: Record<string, unknown> | null;
        has_submission: boolean;
        started_at: Date;
        completed_at: Date | null;
        created_at: Date;
      }>
    >`
      SELECT a.id::text AS id, a.user_id::text AS user_id, u.name AS user_name, a.status, a.failure_reason, a.attempt_number,
             a.provider, a.confidence::text AS confidence, a.masked_attributes, a.started_at, a.completed_at, a.created_at,
             EXISTS (SELECT 1 FROM verification_submissions s WHERE s.attempt_id = a.id) AS has_submission
      FROM verification_attempts a JOIN users u ON u.id = a.user_id
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limit + 1}
    `;
    return this.pager.page(
      rows.map((r) => ({ ...r, createdAt: r.created_at })),
      limit,
      (r): VerificationRowDto => ({
        id: r.id,
        userId: r.user_id,
        userName: r.user_name,
        status: r.status,
        failureReason: r.failure_reason,
        attemptNumber: r.attempt_number,
        provider: r.provider,
        confidence: r.confidence === null ? null : Number(r.confidence),
        maskedAttributes: r.masked_attributes,
        hasSubmission: r.has_submission,
        startedAt: r.started_at,
        completedAt: r.completed_at,
      }),
    );
  }

  /** One attempt's non-sensitive summary, for reloadable review links. Never reads the submission. */
  async attempt(attemptId: string): Promise<VerificationRowDto> {
    const [row] = (await this.queue({ attemptId, limit: 1 })).items;
    if (!row) throw DomainException.of(RESOURCE_NOT_FOUND);
    return row;
  }

  async userIdOf(attemptId: string): Promise<string> {
    const row = await this.prisma.verificationAttempt.findUnique({ where: { id: attemptId }, select: { userId: true } });
    if (!row) throw DomainException.of(RESOURCE_NOT_FOUND);
    return row.userId;
  }
}

/** Verification review (Backend PRD 24.4 area 2). Identity details need SENSITIVE_DATA_VIEW and leave a record. */
@ApiTags('Admin verification')
@Controller('admin')
export class AdminVerificationController {
  constructor(
    private readonly verification: AdminVerificationService,
    private readonly verificationAdmin: VerificationAdminService,
    private readonly submissions: VerificationService,
    private readonly actions: AdminActionService,
    private readonly sensitive: SensitiveAccessService,
  ) {}

  /** The review queue (REVIEW_REQUIRED by default) or any status. */
  @Get('verifications')
  @AdminAuth('VERIFICATION_VIEW')
  @ApiEnveloped(VerificationRowDto, { isArray: true })
  @ApiErrors(400, 403)
  queue(@Query() query: VerificationQueueQueryDto) {
    return this.verification.queue(query);
  }

  /** Every attempt a user made, newest first. */
  @Get('users/:id/verifications')
  @AdminAuth('VERIFICATION_VIEW')
  @ApiEnveloped(VerificationRowDto, { isArray: true })
  @ApiErrors(403)
  history(@Param('id', ParseUUIDPipe) id: string, @Query() query: PaginationQueryDto) {
    return this.verification.queue({ userId: id, cursor: query.cursor, limit: query.limit });
  }

  /** One attempt's summary. Identity details stay behind the audited submission read. */
  @Get('verifications/:attemptId')
  @AdminAuth('VERIFICATION_VIEW')
  @ApiEnveloped(VerificationRowDto)
  @ApiErrors(403, 404)
  attempt(@Param('attemptId', ParseUUIDPipe) attemptId: string) {
    return this.verification.attempt(attemptId);
  }

  /** What the runner told us: identity details, the ID document and the guarantor. Audited. */
  @Get('verifications/:attemptId/submission')
  @AdminAuth('VERIFICATION_VIEW', 'SENSITIVE_DATA_VIEW')
  @ApiEnveloped(VerificationSubmissionDto)
  @ApiErrors(403, 404)
  async submission(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('attemptId', ParseUUIDPipe) attemptId: string, @ReqCtx() ctx: RequestContext) {
    const submission = await this.submissions.getSubmission(attemptId);
    if (!submission) throw DomainException.of(RESOURCE_NOT_FOUND);
    await this.sensitive.record({
      admin,
      permission: 'SENSITIVE_DATA_VIEW',
      resource: 'verification.submission',
      entityType: 'verification_attempt',
      entityId: attemptId,
      ctx,
    });
    return submission;
  }

  @Post('verifications/:attemptId/approve')
  @HttpCode(200)
  @AdminAuth('VERIFICATION_REVIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async approve(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Body() dto: AdminActionDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    const userId = await this.verification.userIdOf(attemptId);
    return this.actions.run({
      admin,
      action: 'verification.approve',
      entityType: 'verification_attempt',
      entityId: attemptId,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { userId },
      execute: () =>
        this.verificationAdmin.approve(attemptId, { adminId: admin.adminId, ip: ctx.ip, requestId: ctx.requestId }, dto.reasonText ?? dto.reasonCode),
    });
  }

  @Post('verifications/:attemptId/reject')
  @HttpCode(200)
  @AdminAuth('VERIFICATION_REVIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async reject(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Body() dto: RejectVerificationDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    const userId = await this.verification.userIdOf(attemptId);
    return this.actions.run({
      admin,
      action: 'verification.reject',
      entityType: 'verification_attempt',
      entityId: attemptId,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { userId, failureReason: dto.failureReason },
      execute: () =>
        this.verificationAdmin.reject(
          attemptId,
          { adminId: admin.adminId, ip: ctx.ip, requestId: ctx.requestId },
          { reason: dto.reasonText ?? dto.reasonCode, failureReason: dto.failureReason, countsAgainstAllowance: dto.countsAgainstAllowance },
        ),
    });
  }

  /** Give the runner a fresh set of tries after a provider problem. */
  @Post('users/:id/verification/grant-attempts')
  @HttpCode(200)
  @AdminAuth('VERIFICATION_REVIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  grant(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminActionDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    return this.actions.run({
      admin,
      action: 'verification.grant_attempts',
      entityType: 'user',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: async () => ({
        userId: id,
        attemptsReset: await this.verificationAdmin.grantExtraAttempts(id, { adminId: admin.adminId, ip: ctx.ip, requestId: ctx.requestId }, dto.reasonText ?? dto.reasonCode),
      }),
    });
  }

  /** Remove a runner's verification. They verify again to run errands. */
  @Post('users/:id/verification/revoke')
  @HttpCode(200)
  @AdminAuth('VERIFICATION_REVIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  revoke(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminActionDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    return this.actions.run({
      admin,
      action: 'verification.revoke',
      entityType: 'user',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.verificationAdmin.revoke(id, { adminId: admin.adminId, ip: ctx.ip, requestId: ctx.requestId }, dto.reasonText ?? dto.reasonCode),
    });
  }
}

import { ApiPropertyOptional, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApprovalKind, ApprovalRequestStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiEnveloped, ApiErrors } from '../../common/api/api-docs.js';
import { PaginationQueryDto } from '../../common/pagination/pagination.dto.js';
import { ReqCtx } from '../../auth/decorators/request-context.decorator.js';
import type { RequestContext } from '../../auth/auth-audit.service.js';
import { AdminAuth, CurrentAdmin, type AuthenticatedAdmin } from '../decorators/admin-auth.decorator.js';
import { ADMIN_REASON_CODES } from './admin-reasons.js';
import { ApprovalService } from './approval.service.js';

export class ApprovalListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ApprovalRequestStatus })
  @IsOptional()
  @IsEnum(ApprovalRequestStatus)
  status?: ApprovalRequestStatus;

  @ApiPropertyOptional({ enum: ApprovalKind })
  @IsOptional()
  @IsEnum(ApprovalKind)
  kind?: ApprovalKind;

  @ApiPropertyOptional({ description: 'Only the requests you asked for.' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  mine?: boolean;
}

export class ApprovalDecisionDto {
  @ApiPropertyOptional({ maxLength: 500, description: 'A note shown with the decision.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ApprovalDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ApprovalKind }) kind!: ApprovalKind;
  @ApiProperty({ enum: ApprovalRequestStatus }) status!: ApprovalRequestStatus;
  @ApiProperty() requestedBy!: string;
  @ApiProperty() reasonCode!: string;
  @ApiProperty({ nullable: true, type: String }) reasonText!: string | null;
  @ApiProperty({ description: 'What would happen, in one sentence.' }) summary!: string;
  @ApiProperty({ nullable: true, type: String }) targetType!: string | null;
  @ApiProperty({ nullable: true, type: String }) targetId!: string | null;
  @ApiProperty({ type: Object }) payload!: Record<string, unknown>;
  @ApiProperty({ nullable: true, type: String }) decidedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) decisionNote!: string | null;
  @ApiProperty({ nullable: true, type: Date }) decidedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) executedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Object }) result!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: String }) failureReason!: string | null;
  @ApiProperty({ type: Date }) expiresAt!: Date;
  @ApiProperty({ type: Date }) createdAt!: Date;
  @ApiProperty({ description: 'True when you may approve or reject it now: another admin asked, you hold the permission, it is waiting.' })
  canDecide!: boolean;
}

export class ReasonCodesDto {
  @ApiProperty({ type: String, isArray: true }) codes!: string[];
}

/** Four-eyes approvals and the reason-code list (Backend PRD 24.5). */
@ApiTags('Admin approvals')
@Controller('admin')
export class ApprovalController {
  constructor(private readonly approvals: ApprovalService) {}

  @Get('reason-codes')
  @AdminAuth()
  @ApiEnveloped(ReasonCodesDto)
  reasonCodes(): ReasonCodesDto {
    return { codes: [...ADMIN_REASON_CODES] };
  }

  /** What you asked for and what you could decide. */
  @Get('approvals')
  @AdminAuth()
  @ApiEnveloped(ApprovalDto, { isArray: true })
  @ApiErrors(400)
  list(@CurrentAdmin() admin: AuthenticatedAdmin, @Query() query: ApprovalListQueryDto) {
    return this.approvals.list(admin, query);
  }

  @Get('approvals/:id')
  @AdminAuth()
  @ApiEnveloped(ApprovalDto)
  @ApiErrors(404)
  get(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.get(admin, id);
  }

  /** A second admin approves: the action runs now, through its domain service. */
  @Post('approvals/:id/approve')
  @HttpCode(200)
  @AdminAuth()
  @ApiEnveloped(ApprovalDto)
  @ApiErrors(403, 404, 409)
  approve(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApprovalDecisionDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    return this.approvals.approve(admin, id, dto.note, ctx);
  }

  @Post('approvals/:id/reject')
  @HttpCode(200)
  @AdminAuth()
  @ApiEnveloped(ApprovalDto)
  @ApiErrors(403, 404, 409)
  reject(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApprovalDecisionDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    return this.approvals.reject(admin, id, dto.note, ctx);
  }

  /** The admin who asked withdraws a request that is still waiting. */
  @Post('approvals/:id/cancel')
  @HttpCode(200)
  @AdminAuth()
  @ApiEnveloped(ApprovalDto)
  @ApiErrors(403, 404, 409)
  cancel(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @ReqCtx() ctx: RequestContext) {
    return this.approvals.cancel(admin, id, ctx);
  }
}

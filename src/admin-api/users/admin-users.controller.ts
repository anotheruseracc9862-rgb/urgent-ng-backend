import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiEnveloped, ApiErrors } from '../../common/api/api-docs.js';
import { ReqCtx } from '../../auth/decorators/request-context.decorator.js';
import type { RequestContext } from '../../auth/auth-audit.service.js';
import { AdminAuth, CurrentAdmin, type AuthenticatedAdmin } from '../../admin/decorators/admin-auth.decorator.js';
import { AdminActionService } from '../../admin/framework/admin-action.service.js';
import { AdminActionDto } from '../../admin/framework/admin-reasons.js';
import { SensitiveAccessService } from '../../admin/framework/sensitive-access.service.js';
import { EnforcementService } from '../../enforcement/enforcement.service.js';
import { AnyObjectDto } from '../common/any-object.dto.js';
import { AdminUsersService } from './admin-users.service.js';
import {
  AdminUserContactDto,
  AdminUserDetailDto,
  AdminUserListQueryDto,
  AdminUserSummaryDto,
  RevokedSessionsDto,
  SuspendUserDto,
  UserActionResultDto,
} from './admin-users.dto.js';

/** Users (Backend PRD 24.4 area 1). Contact data is masked until SENSITIVE_DATA_VIEW is used (and audited). */
@ApiTags('Admin users')
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly actions: AdminActionService,
    private readonly sensitive: SensitiveAccessService,
    private readonly enforcement: EnforcementService,
  ) {}

  @Get()
  @AdminAuth('USERS_VIEW')
  @ApiEnveloped(AdminUserSummaryDto, { isArray: true })
  @ApiErrors(400, 403)
  search(@Query() query: AdminUserListQueryDto) {
    return this.users.search(query);
  }

  @Get(':id')
  @AdminAuth('USERS_VIEW')
  @ApiEnveloped(AdminUserDetailDto)
  @ApiErrors(403, 404)
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.detail(id);
  }

  /** The full phone number and email. Audited. */
  @Get(':id/contact')
  @AdminAuth('SENSITIVE_DATA_VIEW')
  @ApiEnveloped(AdminUserContactDto)
  @ApiErrors(403, 404)
  async contact(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @ReqCtx() ctx: RequestContext) {
    await this.users.requireUser(id);
    await this.sensitive.record({
      admin,
      permission: 'SENSITIVE_DATA_VIEW',
      resource: 'user.contact',
      entityType: 'user',
      entityId: id,
      ctx,
    });
    return this.users.contact(id);
  }

  @Get(':id/consents')
  @AdminAuth('USERS_VIEW')
  @ApiErrors(403, 404)
  @ApiEnveloped(AnyObjectDto)
  async consents(@Param('id', ParseUUIDPipe) id: string) {
    await this.users.requireUser(id);
    return this.users.consentHistory(id);
  }

  @Get(':id/enforcement')
  @AdminAuth('USERS_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  @ApiErrors(403, 404)
  enforcementOf(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.enforcementOf(id);
  }

  /** The ladder explained: every event in the window that adds points. */
  @Get(':id/ladder')
  @AdminAuth('USERS_VIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(403, 404)
  ladder(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.ladder(id);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @AdminAuth('USERS_MANAGE')
  @ApiEnveloped(UserActionResultDto)
  @ApiErrors(400, 403, 404, 409)
  deactivate(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminActionDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    return this.actions.run({
      admin,
      action: 'user.deactivate',
      entityType: 'user',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.users.deactivate(id, dto.reasonText ?? dto.reasonCode, ctx),
    });
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @AdminAuth('USERS_MANAGE')
  @ApiEnveloped(UserActionResultDto)
  @ApiErrors(400, 403, 404, 409)
  reactivate(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminActionDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    return this.actions.run({
      admin,
      action: 'user.reactivate',
      entityType: 'user',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.users.reactivate(id, ctx),
    });
  }

  @Post(':id/revoke-sessions')
  @HttpCode(200)
  @AdminAuth('USERS_MANAGE')
  @ApiEnveloped(RevokedSessionsDto)
  @ApiErrors(400, 403, 404)
  revokeSessions(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminActionDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    return this.actions.run({
      admin,
      action: 'user.revoke_sessions',
      entityType: 'user',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.users.revokeSessions(id),
    });
  }

  /** A temporary suspension, applied now. A permanent one is requested under /admin/enforcement and approved by a second admin. */
  @Post(':id/suspend')
  @HttpCode(200)
  @AdminAuth('ENFORCEMENT_APPLY')
  @ApiEnveloped(UserActionResultDto)
  @ApiErrors(400, 403, 404, 409)
  suspend(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendUserDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    return this.actions.run({
      admin,
      action: 'user.suspend',
      entityType: 'user',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { days: dto.days },
      execute: async () => {
        await this.users.requireUser(id);
        await this.enforcement.adminApply(
          { userId: id, type: 'TEMPORARY_SUSPENSION', reason: dto.reasonText ?? dto.reasonCode, durationDays: dto.days },
          { adminId: admin.adminId },
        );
        return this.users.statusOf(id);
      },
    });
  }
}

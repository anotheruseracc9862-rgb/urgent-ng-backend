import { ApiTags } from '@nestjs/swagger';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import * as R from './dto/responses.dto.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ConsumerAuth } from './decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from './decorators/current-user.decorator.js';
import { ReqCtx } from './decorators/request-context.decorator.js';
import type { RequestContext } from './auth-audit.service.js';
import { ProfileService } from './profile.service.js';
import { AccountService } from './account.service.js';
import { SessionService } from './session.service.js';
import { NotificationPreferenceService } from './notification-preference.service.js';
import { ConsentService } from './consent.service.js';
import { AccountSecurityService } from './account-security.service.js';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import { DeviceService } from './device.service.js';
import { BlockService } from './block.service.js';
import {
  AcceptConsentDto,
  AccountReasonDto,
  ChangePasswordDto,
  ContactChangeRequestDto,
  ContactChangeVerifyDto,
  QuietHoursDto,
  RegisterDeviceDto,
  UpdateMeDto,
  UpdatePreferencesDto,
} from './dto/me.dto.js';

/**
 * The signed-in user's own account (Backend PRD 30.1).
 *
 * Read-only routes and the routes that let a user get out of a restricted state
 * (reactivate, cancel deletion, accept a policy, manage sessions) are open to every
 * non-deleted status. Routes that change profile data need an ACTIVE or DEACTIVATED account.
 */
@ApiTags('Me')
@Controller('me')
export class MeController {
  constructor(
    private readonly profile: ProfileService,
    private readonly account: AccountService,
    private readonly sessions: SessionService,
    private readonly preferences: NotificationPreferenceService,
    private readonly consents: ConsentService,
    private readonly devices: DeviceService,
    private readonly blocks: BlockService,
    private readonly security: AccountSecurityService,
  ) {}

  @Get()
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.MeDto)
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.profile.getMe(user.userId);
  }

  @Patch()
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.MeDto)
  @ApiErrors(400)
  updateMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateMeDto) {
    return this.profile.updateMe(user.userId, dto);
  }

  /** Change the password. Asks for the current one; every other session ends. */
  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit('auth')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(null, { status: 204 })
  @ApiErrors(400, 401, 429)
  async changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto, @ReqCtx() ctx: RequestContext) {
    await this.security.changePassword(
      user.userId,
      user.sessionId,
      { currentPassword: dto.currentPassword, googleIdToken: dto.googleIdToken },
      dto.newPassword,
      ctx,
    );
  }

  /** Add or change the phone number or email: sends a code to the new value. */
  @Post('contact')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(R.ContactChangeSentDto)
  @ApiErrors(400, 401, 409, 429)
  requestContact(@CurrentUser() user: AuthenticatedUser, @Body() dto: ContactChangeRequestDto, @ReqCtx() ctx: RequestContext) {
    return this.security.requestContactChange(user.userId, dto, ctx);
  }

  /** Confirm the code for the new phone number or email. */
  @Post('contact/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(R.ContactChangedDto)
  @ApiErrors(400, 409, 429)
  verifyContact(@CurrentUser() user: AuthenticatedUser, @Body() dto: ContactChangeVerifyDto, @ReqCtx() ctx: RequestContext) {
    return this.security.verifyContact(user.userId, dto, ctx);
  }

  @Post('deactivate')
  @HttpCode(HttpStatus.OK)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(R.AccountChangeDto)
  @ApiErrors(409)
  deactivate(@CurrentUser() user: AuthenticatedUser, @Body() dto: AccountReasonDto, @ReqCtx() ctx: RequestContext) {
    return this.account.deactivate(user.userId, dto.reason, ctx);
  }

  @Post('reactivate')
  @HttpCode(HttpStatus.OK)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.AccountChangeDto)
  @ApiErrors(409)
  reactivate(@CurrentUser() user: AuthenticatedUser, @ReqCtx() ctx: RequestContext) {
    return this.account.reactivate(user.userId, ctx);
  }

  @Post('delete-request')
  @HttpCode(HttpStatus.OK)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.AccountChangeDto)
  @ApiErrors(409)
  requestDeletion(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AccountReasonDto,
    @ReqCtx() ctx: RequestContext,
  ) {
    return this.account.requestDeletion(user.userId, dto.reason, ctx);
  }

  @Delete('delete-request')
  @HttpCode(HttpStatus.OK)
  @ConsumerAuth({ allow: ['DELETION_PENDING'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.AccountChangeDto)
  @ApiErrors(409)
  cancelDeletion(@CurrentUser() user: AuthenticatedUser, @ReqCtx() ctx: RequestContext) {
    return this.account.cancelDeletion(user.userId, ctx);
  }

  @Get('sessions')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.SessionDto, { isArray: true })
  listSessions(@CurrentUser() user: AuthenticatedUser) {
    return this.sessions.list(user.userId, user.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] })
  @ApiConsumerAuth()
  @ApiEnveloped(null, { status: 204 })
  @ApiErrors(404)
  async revokeSession(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.sessions.revokeUserSession(user.userId, id);
  }

  @Get('notification-preferences')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.PreferenceEntryViewDto, { isArray: true })
  getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.preferences.get(user.userId);
  }

  @Get('quiet-hours')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.QuietHoursViewDto)
  getQuietHours(@CurrentUser() user: AuthenticatedUser) {
    return this.preferences.getQuietHours(user.userId);
  }

  /** Set the quiet window (Lagos time), or send both as null for the default. */
  @Put('quiet-hours')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.QuietHoursViewDto)
  @ApiErrors(400)
  setQuietHours(@CurrentUser() user: AuthenticatedUser, @Body() dto: QuietHoursDto) {
    return this.preferences.setQuietHours(user.userId, dto.start, dto.end);
  }

  @Put('notification-preferences')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.PreferenceEntryViewDto, { isArray: true })
  @ApiErrors(400)
  setPreferences(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdatePreferencesDto) {
    return this.preferences.set(user.userId, dto.preferences);
  }

  @Get('consents')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.ConsentHistoryDto)
  listConsents(@CurrentUser() user: AuthenticatedUser) {
    return this.consents.history(user.userId);
  }

  @Post('consents')
  @HttpCode(HttpStatus.OK)
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.ConsentViewDto)
  @ApiErrors(400)
  acceptConsent(@CurrentUser() user: AuthenticatedUser, @Body() dto: AcceptConsentDto, @ReqCtx() ctx: RequestContext) {
    return this.consents.accept(user.userId, dto.type, dto.version, ctx);
  }

  @Post('consents/:id/withdraw')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(null, { status: 204 })
  @ApiErrors(400, 404)
  async withdrawConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqCtx() ctx: RequestContext,
  ) {
    await this.consents.withdraw(user.userId, id, ctx);
  }

  @Get('devices')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.DeviceViewDto, { isArray: true })
  listDevices(@CurrentUser() user: AuthenticatedUser) {
    return this.devices.list(user.userId);
  }

  @Post('devices')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.DeviceViewDto, { status: 201 })
  @ApiErrors(400)
  registerDevice(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterDeviceDto) {
    return this.devices.register(user.userId, dto.type, dto.pushToken);
  }

  @Delete('devices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(null, { status: 204 })
  @ApiErrors(404)
  async removeDevice(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.devices.remove(user.userId, id);
  }

  @Get('blocks')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.BlockedUserDto, { isArray: true })
  listBlocks(@CurrentUser() user: AuthenticatedUser) {
    return this.blocks.list(user.userId);
  }
}

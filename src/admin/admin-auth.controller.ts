import { ApiTags } from '@nestjs/swagger';
import { ApiEnveloped, ApiErrors, ApiAdminAuth } from '../common/api/api-docs.js';
import * as AR from './dto/admin-responses.dto.js';
import { LoggedOutDto } from '../auth/dto/responses.dto.js';
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { AUTH_REQUIRED } from '../common/constants/error-codes.js';
import { ReqCtx } from '../auth/decorators/request-context.decorator.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminUserService } from './admin-user.service.js';
import { AdminSessionService } from './admin-session.service.js';
import type { AdminRequestContext } from './admin-auth-event.service.js';
import { AdminAuth, CurrentAdmin, type AuthenticatedAdmin } from './decorators/admin-auth.decorator.js';
import { ADMIN_REFRESH_COOKIE, clearAdminCookies, setAdminCookies } from './admin.cookies.js';
import { AdminLoginDto, AdminRefreshDto, MfaTokenDto, MfaVerifyDto } from './dto/admin-auth.dto.js';

/**
 * Admin authentication (Backend PRD 24.1): /api/v1/admin/auth/...
 * Public admin registration does not exist: admins are created by `npm run admin:create`.
 */
@ApiTags('Admin auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly admins: AdminUserService,
    private readonly sessions: AdminSessionService,
  ) {}

  /** Step 1. Password only; the answer says which MFA step comes next. No session yet. */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiEnveloped(AR.AdminLoginStepDto)
  @ApiErrors(400, 401, 429)
  async login(
    @Body() dto: AdminLoginDto,
    @ReqCtx() ctx: AdminRequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto.email, dto.password, ctx);
    if (result.status !== 'AUTHENTICATED') return result;
    // Only when ADMIN_MFA_REQUIRED=false: the password alone starts the session.
    setAdminCookies(res, result.tokens);
    return { status: result.status, admin: result.admin, expiresIn: result.tokens.expiresIn, refreshToken: result.tokens.refreshToken, accessToken: result.tokens.accessToken };
  }

  /** First login: get the TOTP secret to put in an authenticator app. */
  @Post('mfa/enrol')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiEnveloped(AR.MfaEnrolmentDto)
  @ApiErrors(401, 409)
  enrol(@Body() dto: MfaTokenDto) {
    return this.auth.startEnrolment(dto.mfaToken);
  }

  /** Step 2. A valid TOTP code completes the login and sets the admin cookies. */
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiEnveloped(AR.AdminSessionResultDto)
  @ApiErrors(401, 429)
  async verify(
    @Body() dto: MfaVerifyDto,
    @ReqCtx() ctx: AdminRequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { admin, tokens } = await this.auth.verifyMfa(dto.mfaToken, dto.code, ctx);
    setAdminCookies(res, tokens);
    return { admin, expiresIn: tokens.expiresIn, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiEnveloped(AR.AdminRefreshResultDto)
  @ApiErrors(401)
  async refresh(
    @Body() dto: AdminRefreshDto,
    @Req() req: Request,
    @ReqCtx() ctx: AdminRequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookie = req.cookies?.[ADMIN_REFRESH_COOKIE];
    const token = typeof cookie === 'string' && cookie !== '' ? cookie : dto.refreshToken;
    if (!token) {
      throw DomainException.of(AUTH_REQUIRED);
    }

    try {
      const tokens = await this.auth.refresh(token, ctx);
      setAdminCookies(res, tokens);
      return { expiresIn: tokens.expiresIn, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken };
    } catch (error) {
      clearAdminCookies(res);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @AdminAuth()
  @ApiAdminAuth()
  @ApiEnveloped(LoggedOutDto)
  async logout(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqCtx() ctx: AdminRequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(admin.sessionId, admin.adminId, ctx);
    clearAdminCookies(res);
    return { loggedOut: true };
  }

  @Get('me')
  @AdminAuth()
  @ApiAdminAuth()
  @ApiEnveloped(AR.AdminViewDto)
  me(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.admins.view(admin.adminId);
  }
}

import { ApiTags } from '@nestjs/swagger';
import { ApiEnveloped, ApiErrors } from '../common/api/api-docs.js';
import * as R from './dto/responses.dto.js';
import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import { RequiresFlag } from '../common/decorators/requires-flag.decorator.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { AUTH_REQUIRED } from '../common/constants/error-codes.js';
import { RegistrationService } from './registration.service.js';
import { LoginService } from './login.service.js';
import { SessionService } from './session.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { GoogleAuthService } from './google-auth.service.js';
import { ReqCtx } from './decorators/request-context.decorator.js';
import type { RequestContext } from './auth-audit.service.js';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies, wantsBodyTokens } from './auth.cookies.js';
import { singleIdentifier } from './identifier.js';
import {
  ForgotPasswordDto,
  GoogleSignInDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  ResendOtpDto,
  ResetPasswordDto,
  VerifyOtpDto,
} from './dto/auth.dto.js';

/**
 * Authentication endpoints (Backend PRD 30.1). All public.
 *
 * Web clients receive the access token (`ung_at`) and refresh token (`ung_rt`) as
 * HTTP-only cookies. Mobile and other clients send `X-Client: mobile` and receive
 * the tokens in the response body instead.
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly login: LoginService,
    private readonly sessions: SessionService,
    private readonly passwordReset: PasswordResetService,
    private readonly googleAuth: GoogleAuthService,
  ) {}

  @Post('register')
  @RequiresFlag('FEATURE_REGISTRATIONS_ENABLED')
  @RateLimit('auth')
  @ApiEnveloped(R.RegisterResultDto, { status: 201 })
  @ApiErrors(400, 403, 409, 503)
  async register(@Body() dto: RegisterDto, @ReqCtx() ctx: RequestContext) {
    return this.registration.register(
      {
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        password: dto.password,
        consents: dto.consents,
        homeArea: dto.homeArea,
      },
      ctx,
    );
  }

  /**
   * Verify the registration code and mark the phone or email as verified. A new account is signed in
   * at the same moment (web clients get their session cookies), so the person lands in the app
   * without a second login. Mobile clients (`X-Client: mobile`) still sign in with `/auth/login`.
   */
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiEnveloped(R.VerifiedDto)
  @ApiErrors(400, 429)
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Headers('x-client') client: string | undefined,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const userId = await this.registration.verify(singleIdentifier(dto), dto.code, ctx);
    if (!wantsBodyTokens(client)) {
      const tokens = await this.login.signInAfterVerification(userId, ctx);
      if (tokens) setAuthCookies(res, tokens);
    }
    return { verified: true };
  }

  /** Always answers the same, whether or not the account exists. */
  @Post('otp/resend')
  @HttpCode(HttpStatus.OK)
  @RateLimit('otp')
  @ApiEnveloped(R.SentDto)
  @ApiErrors(429, 502)
  async resendOtp(@Body() dto: ResendOtpDto, @ReqCtx() ctx: RequestContext) {
    await this.registration.resend(singleIdentifier(dto), ctx);
    return { sent: true };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiEnveloped(R.LoginResultDto)
  @ApiErrors(400, 401, 403, 429)
  async doLogin(
    @Body() dto: LoginDto,
    @Headers('x-client') client: string | undefined,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.login.login(singleIdentifier(dto), dto.password, ctx);
    const { tokens } = result;

    if (wantsBodyTokens(client)) {
      return {
        userId: result.userId,
        status: result.status,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      };
    }
    setAuthCookies(res, tokens);
    return { userId: result.userId, status: result.status, expiresIn: tokens.expiresIn };
  }

  /**
   * Sign in with Google. Answers like `/auth/login`. The first time, send `consents` too: without
   * them the answer is 409 `GOOGLE_SIGNUP_REQUIRED` with the email and name Google gave.
   */
  @Post('google')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiEnveloped(R.GoogleLoginResultDto)
  @ApiErrors(400, 401, 403, 409, 429, 503)
  async googleSignIn(
    @Body() dto: GoogleSignInDto,
    @Headers('x-client') client: string | undefined,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.googleAuth.signIn(dto, ctx);
    const { tokens } = result;

    if (wantsBodyTokens(client)) {
      return {
        userId: result.userId,
        status: result.status,
        isNewAccount: result.isNewAccount,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      };
    }
    setAuthCookies(res, tokens);
    return { userId: result.userId, status: result.status, isNewAccount: result.isNewAccount, expiresIn: tokens.expiresIn };
  }

  /** Rotates the refresh token. Reusing an already-rotated token ends that login. */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiEnveloped(R.RefreshResultDto)
  @ApiErrors(401)
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Headers('x-client') client: string | undefined,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = this.refreshTokenFrom(dto, req, client);
    if (!token) {
      throw DomainException.of(AUTH_REQUIRED);
    }

    let tokens;
    try {
      tokens = await this.sessions.refresh(token, ctx);
    } catch (error) {
      if (!wantsBodyTokens(client)) {
        clearAuthCookies(res);
      }
      throw error;
    }

    if (wantsBodyTokens(client)) {
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      };
    }
    setAuthCookies(res, tokens);
    return { expiresIn: tokens.expiresIn };
  }

  /** Ends the login that owns the refresh token. Always succeeds (idempotent). */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiEnveloped(R.LoggedOutDto)
  async logout(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Headers('x-client') client: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = this.refreshTokenFrom(dto, req, client);
    if (token) {
      await this.sessions.revokeByRefreshToken(token);
    }
    clearAuthCookies(res);
    return { loggedOut: true };
  }

  /** Always answers the same, whether or not the account exists. */
  @Post('password/forgot')
  @HttpCode(HttpStatus.OK)
  @RateLimit('otp')
  @ApiEnveloped(R.SentDto)
  @ApiErrors(429, 502)
  async forgot(@Body() dto: ForgotPasswordDto, @ReqCtx() ctx: RequestContext) {
    await this.passwordReset.forgot(singleIdentifier(dto), ctx);
    return { sent: true };
  }

  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiEnveloped(R.ResetDto)
  @ApiErrors(400, 429)
  async reset(@Body() dto: ResetPasswordDto, @ReqCtx() ctx: RequestContext) {
    await this.passwordReset.reset(singleIdentifier(dto), dto.code, dto.newPassword, ctx);
    return { reset: true };
  }

  /** Web: the `ung_rt` cookie. Mobile: the request body. */
  private refreshTokenFrom(dto: RefreshDto, req: Request, client: string | undefined): string | undefined {
    if (wantsBodyTokens(client)) {
      return dto.refreshToken;
    }
    const cookie = req.cookies?.[REFRESH_COOKIE];
    return typeof cookie === 'string' && cookie !== '' ? cookie : dto.refreshToken;
  }
}

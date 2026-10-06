import { Controller, Post, Body, Ip, HttpCode, HttpStatus, Get, Delete, Param, Req, Res, Headers } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RegistrationService } from './registration.service.js';
import { OtpService, OtpPurpose } from './otp.service.js';
import { LoginService } from './login.service.js';
import { SessionService } from './session.service.js';
import { RegisterDto, SendOtpDto, VerifyOtpDto } from './dto/register.dto.js';
import { LoginDto, RefreshTokenDto, PasswordResetRequestDto, PasswordResetConfirmDto } from './dto/login.dto.js';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';
import * as argon2 from 'argon2';

/**
 * Authentication Controller (P2-02, P2-03)
 * Handles registration, OTP, login, sessions, and password reset
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registrationService: RegistrationService,
    private readonly otpService: OtpService,
    private readonly loginService: LoginService,
    private readonly sessionService: SessionService,
  ) {}

  /**
   * Register a new user
   * POST /auth/register
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('auth')
  async register(
    @Body() dto: RegisterDto,
    @Ip() ipAddress: string,
  ) {
    const result = await this.registrationService.register(dto, ipAddress);
    return {
      success: true,
      data: {
        userId: result.userId,
        otpSent: result.otpSent,
      },
    };
  }

  /**
   * Send OTP to phone or email
   * POST /auth/otp/send
   */
  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  @RateLimit('otp')
  async sendOtp(
    @Body() dto: SendOtpDto,
    @Ip() ipAddress: string,
  ) {
    const validationError = SendOtpDto.validate(dto);
    if (validationError) {
      return {
        success: false,
        error: validationError,
      };
    }

    const identifier = dto.phone || dto.email!;
    const purpose = OtpPurpose[dto.purpose as keyof typeof OtpPurpose];

    const result = await this.otpService.sendOtp(identifier, purpose, ipAddress);

    return {
      success: result.success,
      retryAfterSeconds: result.retryAfterSeconds,
      error: result.error,
    };
  }

  /**
   * Verify OTP code
   * POST /auth/otp/verify
   * 
   * If userId is provided, marks that user's identifier as verified.
   * If userId is not provided, looks up user by identifier and marks as verified.
   */
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    const validationError = VerifyOtpDto.validate(dto);
    if (validationError) {
      return {
        success: false,
        error: validationError,
      };
    }

    const identifier = dto.phone || dto.email!;
    const purpose = OtpPurpose[dto.purpose as keyof typeof OtpPurpose];

    // If userId provided, verify for that specific user
    if (dto.userId) {
      const result = await this.registrationService.verifyRegistrationOtp(
        dto.userId,
        identifier,
        dto.code,
      );
      return {
        success: result.success,
        error: result.error,
      };
    }

    // Otherwise, lookup user by identifier and verify
    if (purpose === OtpPurpose.REGISTRATION || 
        purpose === OtpPurpose.PHONE_VERIFICATION || 
        purpose === OtpPurpose.EMAIL_VERIFICATION) {
      const result = await this.registrationService.verifyIdentifierByLookup(
        identifier,
        dto.code,
        purpose,
      );
      return {
        success: result.success,
        userId: result.userId,
        error: result.error,
      };
    }

    // For other purposes (e.g., password reset), just verify the OTP without marking user as verified
    const result = await this.otpService.verifyOtp(identifier, dto.code, purpose);
    return {
      success: result.success,
      remainingAttempts: result.remainingAttempts,
      error: result.error,
    };
  }

  /**
   * Login with email or phone
   * POST /auth/login
   * 
   * Supports two modes:
   * - Web: Sets HTTP-only cookie 'ung_at' for access token
   * - Mobile: Returns tokens in response body (X-Client: mobile)
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  async login(
    @Body() dto: LoginDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @Headers('x-client') clientType: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const validationError = LoginDto.validate(dto);
    if (validationError) {
      return {
        success: false,
        error: validationError,
      };
    }

    const identifier = dto.phone || dto.email!;
    const result = await this.loginService.login(
      identifier,
      dto.password,
      userAgent,
      ipAddress,
    );

    // Mobile mode: return tokens in body
    if (clientType === 'mobile') {
      return {
        success: true,
        data: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresIn: result.expiresIn,
          userId: result.userId,
        },
      };
    }

    // Web mode: set HTTP-only cookie
    res.cookie('ung_at', result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: result.expiresIn * 1000,
    });

    return {
      success: true,
      data: {
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        userId: result.userId,
      },
    };
  }

  /**
   * Refresh access token
   * POST /auth/refresh
   * 
   * Rotates refresh token and detects reuse (revokes family on reuse)
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @Headers('x-client') clientType: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.sessionService.refreshSession(
      dto.refreshToken,
      userAgent,
      ipAddress,
    );

    // Mobile mode: return tokens in body
    if (clientType === 'mobile') {
      return {
        success: true,
        data: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresIn: result.expiresIn,
        },
      };
    }

    // Web mode: update cookie
    res.cookie('ung_at', result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: result.expiresIn * 1000,
    });

    return {
      success: true,
      data: {
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
      },
    };
  }

  /**
   * Logout (revoke current session)
   * POST /auth/logout
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body() body: { sessionId: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.sessionService.revokeSession(body.sessionId);

    // Clear cookie
    res.clearCookie('ung_at');

    return {
      success: true,
      message: 'Logged out successfully',
    };
  }

  /**
   * List user sessions
   * GET /auth/sessions
   * 
   * TODO: Add authentication guard when available (P2-04)
   */
  @Get('sessions')
  async listSessions(@Body() body: { userId: string }) {
    const sessions = await this.sessionService.listUserSessions(body.userId);

    return {
      success: true,
      data: sessions,
    };
  }

  /**
   * Revoke a specific session
   * DELETE /auth/sessions/:id
   * 
   * TODO: Add authentication guard when available (P2-04)
   */
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  async revokeSession(@Param('id') sessionId: string) {
    await this.sessionService.revokeSession(sessionId);

    return {
      success: true,
      message: 'Session revoked',
    };
  }

  /**
   * Request password reset OTP
   * POST /auth/password-reset/request
   */
  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  @RateLimit('otp')
  async requestPasswordReset(
    @Body() dto: PasswordResetRequestDto,
    @Ip() ipAddress: string,
  ) {
    const validationError = PasswordResetRequestDto.validate(dto);
    if (validationError) {
      return {
        success: false,
        error: validationError,
      };
    }

    const identifier = dto.phone || dto.email!;
    const result = await this.otpService.sendOtp(
      identifier,
      OtpPurpose.PASSWORD_RESET,
      ipAddress,
    );

    return {
      success: result.success,
      retryAfterSeconds: result.retryAfterSeconds,
      error: result.error,
    };
  }

  /**
   * Confirm password reset with OTP
   * POST /auth/password-reset/confirm
   * 
   * Verifies OTP, sets new password, and revokes all sessions
   */
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  async confirmPasswordReset(@Body() dto: PasswordResetConfirmDto) {
    const validationError = PasswordResetConfirmDto.validate(dto);
    if (validationError) {
      return {
        success: false,
        error: validationError,
      };
    }

    const identifier = dto.phone || dto.email!;

    // Verify OTP
    const otpResult = await this.otpService.verifyOtp(
      identifier,
      dto.code,
      OtpPurpose.PASSWORD_RESET,
    );

    if (!otpResult.success) {
      return {
        success: false,
        error: otpResult.error,
        remainingAttempts: otpResult.remainingAttempts,
      };
    }

    // Find user
    const isPhone = identifier.startsWith('+');
    const user = await this.registrationService['prisma'].user.findFirst({
      where: isPhone
        ? { phoneE164: identifier, deletedAt: null }
        : { email: identifier, deletedAt: null },
    });

    if (!user) {
      return {
        success: false,
        error: 'USER_NOT_FOUND',
      };
    }

    // Hash new password
    const passwordHash = await argon2.hash(dto.newPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    // Update password
    await this.registrationService['prisma'].user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    // Revoke all sessions
    await this.sessionService.revokeAllUserSessions(user.id);

    return {
      success: true,
      message: 'Password reset successful. All sessions have been revoked.',
    };
  }
}

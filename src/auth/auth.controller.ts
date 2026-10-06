import { Controller, Post, Body, Ip, HttpCode, HttpStatus } from '@nestjs/common';
import { RegistrationService } from './registration.service.js';
import { OtpService, OtpPurpose } from './otp.service.js';
import { RegisterDto, SendOtpDto, VerifyOtpDto } from './dto/register.dto.js';
import { RateLimit } from '../common/decorators/rate-limit.decorator.js';

/**
 * Authentication Controller (P2-02)
 * Handles registration, OTP sending, and verification
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registrationService: RegistrationService,
    private readonly otpService: OtpService,
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
}

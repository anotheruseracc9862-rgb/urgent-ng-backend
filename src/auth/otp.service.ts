import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { createHmac, randomInt } from 'crypto';
import type {
  IOtpDeliveryProvider,
  OtpDeliveryPayload,
} from './otp-delivery.provider.js';

/**
 * OTP Service (P2-02)
 * Per PRD §9.2:
 * - 6-digit cryptographically random code
 * - 10-minute TTL
 * - Stored hashed in Redis
 * - Maximum 5 verification attempts per code
 * - 60s resend cooldown
 * - Maximum 5 OTPs per destination per hour
 * - Maximum 10 OTPs per IP per hour
 * - OTP values are NEVER logged
 */

export enum OtpPurpose {
  REGISTRATION = 'REGISTRATION',
  PASSWORD_RESET = 'PASSWORD_RESET',
  PHONE_VERIFICATION = 'PHONE_VERIFICATION',
  EMAIL_VERIFICATION = 'EMAIL_VERIFICATION',
}

export interface OtpSendResult {
  success: boolean;
  code?: string; // SECURITY: Only for immediate delivery, never log this!
  remainingAttempts?: number;
  retryAfterSeconds?: number;
  error?: string;
}

export interface OtpVerifyResult {
  success: boolean;
  remainingAttempts?: number;
  error?: string;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly redis: Redis;
  private readonly hmacSecret: string;

  // Configuration from BusinessConfigService (via config)
  private readonly OTP_TTL_SECONDS = 600; // 10 minutes
  private readonly OTP_MAX_ATTEMPTS = 5;
  private readonly OTP_RESEND_COOLDOWN_SECONDS = 60;
  private readonly OTP_HOURLY_LIMIT_PER_DESTINATION = 5;
  private readonly OTP_HOURLY_LIMIT_PER_IP = 10;

  constructor(
    private readonly config: ConfigService,
    @Inject('IOtpDeliveryProvider')
    private readonly deliveryProvider: IOtpDeliveryProvider,
  ) {
    this.redis = new Redis(this.config.getOrThrow<string>('redis.url'));
    this.hmacSecret = this.config.getOrThrow<string>('security.otpHmacSecret');
  }

  /**
   * Generate and send an OTP to a destination (phone or email).
   * Returns success=false if rate limits are exceeded.
   */
  async sendOtp(
    destination: string,
    purpose: OtpPurpose,
    ipAddress?: string,
  ): Promise<OtpSendResult> {
    // Check resend cooldown
    const cooldownKey = this.getCooldownKey(destination, purpose);
    const cooldownTtl = await this.redis.ttl(cooldownKey);
    if (cooldownTtl > 0) {
      return {
        success: false,
        retryAfterSeconds: cooldownTtl,
        error: 'RESEND_COOLDOWN_ACTIVE',
      };
    }

    // Check hourly limit per destination
    const destLimitKey = this.getDestinationLimitKey(destination, purpose);
    const destCount = await this.redis.get(destLimitKey);
    if (destCount && parseInt(destCount, 10) >= this.OTP_HOURLY_LIMIT_PER_DESTINATION) {
      return {
        success: false,
        error: 'DESTINATION_HOURLY_LIMIT_EXCEEDED',
      };
    }

    // Check hourly limit per IP (if provided)
    if (ipAddress) {
      const ipLimitKey = this.getIpLimitKey(ipAddress, purpose);
      const ipCount = await this.redis.get(ipLimitKey);
      if (ipCount && parseInt(ipCount, 10) >= this.OTP_HOURLY_LIMIT_PER_IP) {
        return {
          success: false,
          error: 'IP_HOURLY_LIMIT_EXCEEDED',
        };
      }
    }

    // Generate 6-digit OTP (cryptographically secure)
    const code = this.generateOtp();
    
    // Hash the OTP before storing
    const hashedCode = this.hashOtp(code);

    // Store hashed OTP with metadata
    const otpKey = this.getOtpKey(destination, purpose);
    await this.redis.setex(
      otpKey,
      this.OTP_TTL_SECONDS,
      JSON.stringify({
        hash: hashedCode,
        attempts: 0,
        createdAt: Date.now(),
      }),
    );

    // Set resend cooldown
    await this.redis.setex(
      cooldownKey,
      this.OTP_RESEND_COOLDOWN_SECONDS,
      '1',
    );

    // Increment hourly counters
    const hourTtl = 3600; // 1 hour
    await this.redis.incr(destLimitKey);
    await this.redis.expire(destLimitKey, hourTtl);

    if (ipAddress) {
      const ipLimitKey = this.getIpLimitKey(ipAddress, purpose);
      await this.redis.incr(ipLimitKey);
      await this.redis.expire(ipLimitKey, hourTtl);
    }

    // Log OTP generation (NEVER log the actual code!)
    this.logger.log({
      message: 'OTP generated',
      destination: this.maskDestination(destination),
      purpose,
      ipAddress,
    });

    // Deliver the OTP through the provider
    const deliveryResult = await this.deliveryProvider.send({
      identifier: destination,
      code,
      purpose: this.mapPurposeToDeliveryPurpose(purpose),
    });

    if (!deliveryResult.success) {
      this.logger.error({
        message: 'OTP delivery failed',
        destination: this.maskDestination(destination),
        purpose,
        error: deliveryResult.error,
      });
      return {
        success: false,
        error: 'DELIVERY_FAILED',
      };
    }

    // Return success (code is returned only for immediate use in testing)
    return {
      success: true,
      code, // SECURITY: Only for immediate delivery, never log this!
    };
  }

  /**
   * Verify an OTP code.
   * Returns success=true if the code is correct and not expired.
   * Increments attempt counter and may lock out after max attempts.
   */
  async verifyOtp(
    destination: string,
    code: string,
    purpose: OtpPurpose,
  ): Promise<OtpVerifyResult> {
    const otpKey = this.getOtpKey(destination, purpose);
    const otpData = await this.redis.get(otpKey);

    if (!otpData) {
      return {
        success: false,
        error: 'OTP_NOT_FOUND_OR_EXPIRED',
      };
    }

    const { hash, attempts } = JSON.parse(otpData);

    // Check if max attempts exceeded
    if (attempts >= this.OTP_MAX_ATTEMPTS) {
      return {
        success: false,
        remainingAttempts: 0,
        error: 'MAX_ATTEMPTS_EXCEEDED',
      };
    }

    // Hash the provided code and compare
    const hashedCode = this.hashOtp(code);
    const isValid = hashedCode === hash;

    if (isValid) {
      // Success: delete the OTP
      await this.redis.del(otpKey);
      
      this.logger.log({
        message: 'OTP verified successfully',
        destination: this.maskDestination(destination),
        purpose,
      });

      return { success: true };
    } else {
      // Failed: increment attempts
      const newAttempts = attempts + 1;
      const ttl = await this.redis.ttl(otpKey);
      
      await this.redis.setex(
        otpKey,
        ttl > 0 ? ttl : this.OTP_TTL_SECONDS,
        JSON.stringify({
          hash,
          attempts: newAttempts,
          createdAt: JSON.parse(otpData).createdAt,
        }),
      );

      const remainingAttempts = this.OTP_MAX_ATTEMPTS - newAttempts;

      this.logger.warn({
        message: 'OTP verification failed',
        destination: this.maskDestination(destination),
        purpose,
        remainingAttempts,
      });

      return {
        success: false,
        remainingAttempts,
        error: 'INVALID_OTP',
      };
    }
  }

  /**
   * Generate a cryptographically secure 6-digit OTP.
   */
  private generateOtp(): string {
    // Use randomInt for cryptographically secure random numbers
    const num = randomInt(0, 1000000);
    return num.toString().padStart(6, '0');
  }

  /**
   * Hash an OTP using HMAC-SHA256.
   */
  private hashOtp(code: string): string {
    return createHmac('sha256', this.hmacSecret)
      .update(code)
      .digest('hex');
  }

  /**
   * Mask a destination for logging (show first 2 and last 2 characters).
   */
  private maskDestination(destination: string): string {
    if (destination.length <= 4) return '****';
    return destination.slice(0, 2) + '****' + destination.slice(-2);
  }

  /**
   * Redis key for OTP storage: otp:{destination}:{purpose}
   */
  private getOtpKey(destination: string, purpose: OtpPurpose): string {
    return `otp:${destination}:${purpose}`;
  }

  /**
   * Redis key for resend cooldown: otp:cooldown:{destination}:{purpose}
   */
  private getCooldownKey(destination: string, purpose: OtpPurpose): string {
    return `otp:cooldown:${destination}:${purpose}`;
  }

  /**
   * Redis key for hourly destination limit: otp:dest-limit:{destination}:{purpose}:{hour}
   */
  private getDestinationLimitKey(destination: string, purpose: OtpPurpose): string {
    const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    return `otp:dest-limit:${destination}:${purpose}:${hour}`;
  }

  /**
   * Redis key for hourly IP limit: otp:ip-limit:{ip}:{purpose}:{hour}
   */
  private getIpLimitKey(ipAddress: string, purpose: OtpPurpose): string {
    const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    return `otp:ip-limit:${ipAddress}:${purpose}:${hour}`;
  }

  /**
   * Map OtpPurpose to delivery purpose string
   */
  private mapPurposeToDeliveryPurpose(
    purpose: OtpPurpose,
  ): 'registration' | 'login' | 'verification' {
    switch (purpose) {
      case OtpPurpose.REGISTRATION:
        return 'registration';
      case OtpPurpose.PASSWORD_RESET:
        return 'login';
      case OtpPurpose.PHONE_VERIFICATION:
      case OtpPurpose.EMAIL_VERIFICATION:
        return 'verification';
      default:
        return 'verification';
    }
  }
}

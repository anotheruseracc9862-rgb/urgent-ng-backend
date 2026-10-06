import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import Redis from 'ioredis';
import { beforeEach, describe, expect, it, afterEach } from 'vitest';
import { OtpService, OtpPurpose } from './otp.service.js';
import { FakeOtpDeliveryProvider } from './otp-delivery.provider.js';
import configuration from '../config/configuration.js';

/**
 * OTP Service Integration Tests (P2-02)
 * 
 * Tests cover:
 * - OTP expiry (10 minutes)
 * - Attempt lockout (5 failed attempts)
 * - Resend cooldown (60 seconds)
 * - Hourly caps (5 per destination, 10 per IP)
 * - Code verification with hashed storage
 */

describe('OtpService (Integration)', () => {
  let service: OtpService;
  let redis: Redis;
  let deliveryProvider: FakeOtpDeliveryProvider;

  beforeEach(async () => {
    deliveryProvider = new FakeOtpDeliveryProvider();

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [configuration],
          isGlobal: true,
        }),
      ],
      providers: [
        OtpService,
        {
          provide: 'IOtpDeliveryProvider',
          useValue: deliveryProvider,
        },
      ],
    }).compile();

    service = module.get<OtpService>(OtpService);
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

    // Clean Redis before each test
    const keys = await redis.keys('otp:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    deliveryProvider.clearSentCodes();
  });

  afterEach(async () => {
    await redis.quit();
  });

  describe('OTP Generation and Delivery', () => {
    it('should generate and send a 6-digit OTP', async () => {
      const result = await service.sendOtp(
        '+2348012345678',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      expect(result.success).toBe(true);
      expect(result.code).toBeDefined();
      expect(result.code).toMatch(/^\d{6}$/);

      // Verify delivery provider was called
      const sentCodes = deliveryProvider.getSentCodes('+2348012345678');
      expect(sentCodes).toHaveLength(1);
      expect(sentCodes[0]).toBe(result.code);
    });

    it('should store OTP hashed in Redis', async () => {
      const result = await service.sendOtp(
        '+2348012345678',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      const key = 'otp:+2348012345678:REGISTRATION';
      const stored = await redis.get(key);
      expect(stored).toBeDefined();

      const data = JSON.parse(stored!);
      expect(data.hash).toBeDefined();
      expect(data.attempts).toBe(0);
      expect(data.createdAt).toBeDefined();

      // Ensure the raw code is NOT stored
      expect(stored).not.toContain(result.code!);
    });

    it('should verify a correct OTP', async () => {
      const sendResult = await service.sendOtp(
        '+2348012345678',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      const verifyResult = await service.verifyOtp(
        '+2348012345678',
        sendResult.code!,
        OtpPurpose.REGISTRATION,
      );

      expect(verifyResult.success).toBe(true);
    });

    it('should reject an incorrect OTP', async () => {
      await service.sendOtp(
        '+2348012345678',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      const verifyResult = await service.verifyOtp(
        '+2348012345678',
        '999999',
        OtpPurpose.REGISTRATION,
      );

      expect(verifyResult.success).toBe(false);
      expect(verifyResult.error).toBe('INVALID_OTP');
      expect(verifyResult.remainingAttempts).toBe(4);
    });
  });

  describe('Attempt Lockout', () => {
    it('should allow up to 5 verification attempts', async () => {
      const sendResult = await service.sendOtp(
        '+2348012345678',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      // Make 5 failed attempts
      for (let i = 0; i < 5; i++) {
        const result = await service.verifyOtp(
          '+2348012345678',
          '999999',
          OtpPurpose.REGISTRATION,
        );
        expect(result.success).toBe(false);
        expect(result.remainingAttempts).toBe(4 - i);
      }

      // 6th attempt should be blocked
      const finalResult = await service.verifyOtp(
        '+2348012345678',
        sendResult.code!,
        OtpPurpose.REGISTRATION,
      );

      expect(finalResult.success).toBe(false);
      expect(finalResult.error).toBe('MAX_ATTEMPTS_EXCEEDED');
      expect(finalResult.remainingAttempts).toBe(0);
    });

    it('should delete OTP after successful verification', async () => {
      const sendResult = await service.sendOtp(
        '+2348012345678',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      await service.verifyOtp(
        '+2348012345678',
        sendResult.code!,
        OtpPurpose.REGISTRATION,
      );

      // OTP should be deleted
      const key = 'otp:+2348012345678:REGISTRATION';
      const stored = await redis.get(key);
      expect(stored).toBeNull();

      // Second verification should fail
      const secondResult = await service.verifyOtp(
        '+2348012345678',
        sendResult.code!,
        OtpPurpose.REGISTRATION,
      );

      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toBe('OTP_NOT_FOUND_OR_EXPIRED');
    });
  });

  describe('Resend Cooldown', () => {
    it('should enforce 60-second resend cooldown', async () => {
      await service.sendOtp(
        '+2348012345678',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      // Immediate resend should be blocked
      const resendResult = await service.sendOtp(
        '+2348012345678',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      expect(resendResult.success).toBe(false);
      expect(resendResult.error).toBe('RESEND_COOLDOWN_ACTIVE');
      expect(resendResult.retryAfterSeconds).toBeGreaterThan(0);
      expect(resendResult.retryAfterSeconds).toBeLessThanOrEqual(60);
    });

    it('should allow resend after cooldown expires', async () => {
      await service.sendOtp(
        '+2348012345678',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      // Manually expire the cooldown key
      const cooldownKey = 'otp:cooldown:+2348012345678:REGISTRATION';
      await redis.del(cooldownKey);

      // Resend should now work
      const resendResult = await service.sendOtp(
        '+2348012345678',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      expect(resendResult.success).toBe(true);
      expect(resendResult.code).toBeDefined();
    });
  });

  describe('Hourly Caps', () => {
    it('should enforce 5 OTPs per destination per hour', async () => {
      const destination = '+2348012345678';
      const ip = '192.168.1.1';

      // Send 5 OTPs (should all succeed)
      for (let i = 0; i < 5; i++) {
        // Clear cooldown to allow multiple sends
        const cooldownKey = `otp:cooldown:${destination}:REGISTRATION`;
        await redis.del(cooldownKey);

        const result = await service.sendOtp(destination, OtpPurpose.REGISTRATION, ip);
        expect(result.success).toBe(true);
      }

      // 6th OTP should be blocked
      const cooldownKey = `otp:cooldown:${destination}:REGISTRATION`;
      await redis.del(cooldownKey);

      const sixthResult = await service.sendOtp(destination, OtpPurpose.REGISTRATION, ip);
      expect(sixthResult.success).toBe(false);
      expect(sixthResult.error).toBe('DESTINATION_HOURLY_LIMIT_EXCEEDED');
    });

    it('should enforce 10 OTPs per IP per hour', async () => {
      const ip = '192.168.1.100';

      // Send 10 OTPs to different destinations (should all succeed)
      for (let i = 0; i < 10; i++) {
        const destination = `+23480123456${i.toString().padStart(2, '0')}`;
        const result = await service.sendOtp(destination, OtpPurpose.REGISTRATION, ip);
        expect(result.success).toBe(true);
      }

      // 11th OTP should be blocked
      const eleventhResult = await service.sendOtp(
        '+2348012345699',
        OtpPurpose.REGISTRATION,
        ip,
      );
      expect(eleventhResult.success).toBe(false);
      expect(eleventhResult.error).toBe('IP_HOURLY_LIMIT_EXCEEDED');
    });

    it('should track hourly limits separately per purpose', async () => {
      const destination = '+2348012345678';
      const ip = '192.168.1.1';

      // Send 5 REGISTRATION OTPs
      for (let i = 0; i < 5; i++) {
        const cooldownKey = `otp:cooldown:${destination}:REGISTRATION`;
        await redis.del(cooldownKey);
        const result = await service.sendOtp(destination, OtpPurpose.REGISTRATION, ip);
        expect(result.success).toBe(true);
      }

      // PHONE_VERIFICATION should still work (different purpose)
      const phoneVerifyResult = await service.sendOtp(
        destination,
        OtpPurpose.PHONE_VERIFICATION,
        ip,
      );
      expect(phoneVerifyResult.success).toBe(true);
    });
  });

  describe('OTP Expiry', () => {
    it('should reject expired OTP', async () => {
      const sendResult = await service.sendOtp(
        '+2348012345678',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      // Manually expire the OTP key
      const otpKey = 'otp:+2348012345678:REGISTRATION';
      await redis.del(otpKey);

      // Verification should fail
      const verifyResult = await service.verifyOtp(
        '+2348012345678',
        sendResult.code!,
        OtpPurpose.REGISTRATION,
      );

      expect(verifyResult.success).toBe(false);
      expect(verifyResult.error).toBe('OTP_NOT_FOUND_OR_EXPIRED');
    });

    it('should set 10-minute TTL on OTP', async () => {
      await service.sendOtp(
        '+2348012345678',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      const otpKey = 'otp:+2348012345678:REGISTRATION';
      const ttl = await redis.ttl(otpKey);

      // TTL should be close to 600 seconds (10 minutes)
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThanOrEqual(600);
    });
  });

  describe('Email OTP', () => {
    it('should support email as identifier', async () => {
      const result = await service.sendOtp(
        'test@example.com',
        OtpPurpose.REGISTRATION,
        '192.168.1.1',
      );

      expect(result.success).toBe(true);
      expect(result.code).toBeDefined();

      // Verify
      const verifyResult = await service.verifyOtp(
        'test@example.com',
        result.code!,
        OtpPurpose.REGISTRATION,
      );

      expect(verifyResult.success).toBe(true);
    });
  });
});

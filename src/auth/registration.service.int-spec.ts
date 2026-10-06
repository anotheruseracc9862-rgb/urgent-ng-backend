import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BadRequestException, ConflictException } from '@nestjs/common';
import Redis from 'ioredis';
import { beforeEach, describe, expect, it, afterEach } from 'vitest';
import { RegistrationService } from './registration.service.js';
import { BlocklistService } from './blocklist.service.js';
import { OtpService } from './otp.service.js';
import { FakeOtpDeliveryProvider } from './otp-delivery.provider.js';
import { DatabaseModule } from '../database/database.module.js';
import { PrismaService } from '../database/prisma.service.js';
import configuration from '../config/configuration.js';

/**
 * Registration Service Integration Tests (P2-02)
 * 
 * Tests cover:
 * - Registration with required consents
 * - Blocklist checks (phone and email)
 * - Password hashing with Argon2id
 * - OTP sending after registration
 * - Identifier verification (phone/email)
 */

describe('RegistrationService (Integration)', () => {
  let service: RegistrationService;
  let blocklistService: BlocklistService;
  let prisma: PrismaService;
  let redis: Redis;

  const validConsents = [
    { type: 'TERMS_OF_SERVICE', version: '1.0', accepted: true as const },
    { type: 'PRIVACY_POLICY', version: '1.0', accepted: true as const },
    { type: 'SAFETY_POLICY', version: '1.0', accepted: true as const },
    { type: 'PROHIBITED_ITEMS_POLICY', version: '1.0', accepted: true as const },
  ];

  beforeEach(async () => {
    const deliveryProvider = new FakeOtpDeliveryProvider();

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [configuration],
          isGlobal: true,
        }),
        DatabaseModule,
      ],
      providers: [
        RegistrationService,
        BlocklistService,
        OtpService,
        {
          provide: 'IOtpDeliveryProvider',
          useValue: deliveryProvider,
        },
      ],
    }).compile();

    service = module.get<RegistrationService>(RegistrationService);
    blocklistService = module.get<BlocklistService>(BlocklistService);
    prisma = module.get<PrismaService>(PrismaService);
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

    // Clean database and Redis
    await prisma.consentRecord.deleteMany({});
    await prisma.profile.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.blocklistEntry.deleteMany({});
    await prisma.policyVersion.deleteMany({});

    // Clean Redis
    const keys = await redis.keys('otp:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    // Create required policy versions
    await prisma.policyVersion.createMany({
      data: [
        { type: 'TERMS_OF_SERVICE', version: '1.0', documentRef: 'terms-v1', publishedAt: new Date() },
        { type: 'PRIVACY_POLICY', version: '1.0', documentRef: 'privacy-v1', publishedAt: new Date() },
        { type: 'SAFETY_POLICY', version: '1.0', documentRef: 'safety-v1', publishedAt: new Date() },
        { type: 'PROHIBITED_ITEMS_POLICY', version: '1.0', documentRef: 'prohibited-v1', publishedAt: new Date() },
      ],
    });
  });

  afterEach(async () => {
    await redis.quit();
    await prisma.$disconnect();
  });

  describe('Registration Flow', () => {
    it('should register a user with phone', async () => {
      const result = await service.register(
        {
          name: 'John Doe',
          phone: '+2348012345678',
          password: 'SecurePassword123!',
          consents: validConsents,
        },
        '192.168.1.1',
      );

      expect(result.userId).toBeDefined();
      expect(result.otpSent).toBe(true);

      // Verify user was created
      const user = await prisma.user.findUnique({
        where: { id: result.userId },
      });

      expect(user).toBeDefined();
      expect(user!.name).toBe('John Doe');
      expect(user!.firstName).toBe('John');
      expect(user!.lastName).toBe('Doe');
      expect(user!.phoneE164).toBe('+2348012345678');
      expect(user!.email).toBeNull();
      expect(user!.phoneVerifiedAt).toBeNull();
      expect(user!.passwordHash).toBeDefined();
      expect(user!.passwordHash).not.toBe('SecurePassword123!'); // Should be hashed
    });

    it('should register a user with email', async () => {
      const result = await service.register(
        {
          name: 'Jane Smith',
          email: 'jane@example.com',
          password: 'SecurePassword123!',
          consents: validConsents,
        },
        '192.168.1.1',
      );

      expect(result.userId).toBeDefined();
      expect(result.otpSent).toBe(true);

      // Verify user was created
      const user = await prisma.user.findUnique({
        where: { id: result.userId },
      });

      expect(user).toBeDefined();
      expect(user!.email).toBe('jane@example.com');
      expect(user!.phoneE164).toBeNull();
      expect(user!.emailVerifiedAt).toBeNull();
    });

    it('should create profile for new user', async () => {
      const result = await service.register(
        {
          name: 'John Doe',
          phone: '+2348012345678',
          password: 'SecurePassword123!',
          consents: validConsents,
        },
        '192.168.1.1',
      );

      const profile = await prisma.profile.findUnique({
        where: { userId: result.userId },
      });

      expect(profile).toBeDefined();
      expect(profile!.userId).toBe(result.userId);
    });

    it('should create consent records', async () => {
      const result = await service.register(
        {
          name: 'John Doe',
          phone: '+2348012345678',
          password: 'SecurePassword123!',
          consents: validConsents,
        },
        '192.168.1.1',
      );

      const consents = await prisma.consentRecord.findMany({
        where: { userId: result.userId },
      });

      expect(consents).toHaveLength(4);
      expect(consents.map((c) => c.consentType)).toContain('TERMS_OF_SERVICE');
      expect(consents.map((c) => c.consentType)).toContain('PRIVACY_POLICY');
      expect(consents.map((c) => c.consentType)).toContain('SAFETY_POLICY');
      expect(consents.map((c) => c.consentType)).toContain('PROHIBITED_ITEMS_POLICY');
    });

    it('should reject registration without required consents', async () => {
      await expect(
        service.register(
          {
            name: 'John Doe',
            phone: '+2348012345678',
            password: 'SecurePassword123!',
            consents: [
              { type: 'TERMS_OF_SERVICE', version: '1.0', accepted: true as const },
              // Missing other required consents
            ],
          },
          '192.168.1.1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject registration with invalid policy version', async () => {
      await expect(
        service.register(
          {
            name: 'John Doe',
            phone: '+2348012345678',
            password: 'SecurePassword123!',
            consents: [
              { type: 'TERMS_OF_SERVICE', version: '999.0', accepted: true as const },
              { type: 'PRIVACY_POLICY', version: '1.0', accepted: true as const },
              { type: 'SAFETY_POLICY', version: '1.0', accepted: true as const },
              { type: 'PROHIBITED_ITEMS_POLICY', version: '1.0', accepted: true as const },
            ],
          },
          '192.168.1.1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject duplicate phone registration', async () => {
      await service.register(
        {
          name: 'John Doe',
          phone: '+2348012345678',
          password: 'SecurePassword123!',
          consents: validConsents,
        },
        '192.168.1.1',
      );

      await expect(
        service.register(
          {
            name: 'Jane Smith',
            phone: '+2348012345678',
            password: 'AnotherPassword123!',
            consents: validConsents,
          },
          '192.168.1.1',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject duplicate email registration', async () => {
      await service.register(
        {
          name: 'John Doe',
          email: 'john@example.com',
          password: 'SecurePassword123!',
          consents: validConsents,
        },
        '192.168.1.1',
      );

      await expect(
        service.register(
          {
            name: 'Jane Smith',
            email: 'john@example.com',
            password: 'AnotherPassword123!',
            consents: validConsents,
          },
          '192.168.1.1',
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Blocklist Checks', () => {
    it('should block registration with blocklisted phone', async () => {
      await blocklistService.blockPhone(
        '+2348012345678',
        'PERMANENT_SUSPENSION' as any,
      );

      await expect(
        service.register(
          {
            name: 'John Doe',
            phone: '+2348012345678',
            password: 'SecurePassword123!',
            consents: validConsents,
          },
          '192.168.1.1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should block registration with blocklisted email', async () => {
      await blocklistService.blockEmail(
        'blocked@example.com',
        'FRAUD' as any,
      );

      await expect(
        service.register(
          {
            name: 'John Doe',
            email: 'blocked@example.com',
            password: 'SecurePassword123!',
            consents: validConsents,
          },
          '192.168.1.1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('OTP Verification and Identifier Marking', () => {
    it('should mark phone as verified after OTP verification', async () => {
      const regResult = await service.register(
        {
          name: 'John Doe',
          phone: '+2348012345678',
          password: 'SecurePassword123!',
          consents: validConsents,
        },
        '192.168.1.1',
      );

      // Get the OTP code from Redis (in real scenario, user receives it)
      const otpKey = 'otp:+2348012345678:REGISTRATION';
      const otpData = await redis.get(otpKey);
      expect(otpData).toBeDefined();

      // For testing, we'll use a mock code
      // In production, the OTP is delivered and user provides it
      const mockCode = '123456';
      
      // Manually set a known OTP for testing
      const crypto = await import('crypto');
      const hmacSecret = process.env.OTP_HMAC_SECRET || 'development-only-otp-hmac-secret-not-for-production';
      const hash = crypto.createHmac('sha256', hmacSecret)
        .update(mockCode)
        .digest('hex');
      
      await redis.setex(
        otpKey,
        600,
        JSON.stringify({ hash, attempts: 0, createdAt: Date.now() }),
      );

      // Verify OTP
      const verifyResult = await service.verifyRegistrationOtp(
        regResult.userId,
        '+2348012345678',
        mockCode,
      );

      expect(verifyResult.success).toBe(true);

      // Check that phone is marked as verified
      const user = await prisma.user.findUnique({
        where: { id: regResult.userId },
      });

      expect(user!.phoneVerifiedAt).toBeDefined();
      expect(user!.phoneVerifiedAt).toBeInstanceOf(Date);
    });

    it('should mark email as verified after OTP verification', async () => {
      const regResult = await service.register(
        {
          name: 'Jane Smith',
          email: 'jane@example.com',
          password: 'SecurePassword123!',
          consents: validConsents,
        },
        '192.168.1.1',
      );

      const mockCode = '654321';
      const crypto = await import('crypto');
      const hmacSecret = process.env.OTP_HMAC_SECRET || 'development-only-otp-hmac-secret-not-for-production';
      const hash = crypto.createHmac('sha256', hmacSecret)
        .update(mockCode)
        .digest('hex');
      
      const otpKey = 'otp:jane@example.com:REGISTRATION';
      await redis.setex(
        otpKey,
        600,
        JSON.stringify({ hash, attempts: 0, createdAt: Date.now() }),
      );

      const verifyResult = await service.verifyRegistrationOtp(
        regResult.userId,
        'jane@example.com',
        mockCode,
      );

      expect(verifyResult.success).toBe(true);

      const user = await prisma.user.findUnique({
        where: { id: regResult.userId },
      });

      expect(user!.emailVerifiedAt).toBeDefined();
    });
  });
});

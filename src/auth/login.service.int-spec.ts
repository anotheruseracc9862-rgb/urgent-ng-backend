import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import Redis from 'ioredis';
import { beforeEach, describe, expect, it, afterEach } from 'vitest';
import { LoginService } from './login.service.js';
import { SessionService } from './session.service.js';
import { RegistrationService } from './registration.service.js';
import { OtpService } from './otp.service.js';
import { BlocklistService } from './blocklist.service.js';
import { FakeOtpDeliveryProvider } from './otp-delivery.provider.js';
import { DatabaseModule } from '../database/database.module.js';
import { PrismaService } from '../database/prisma.service.js';
import configuration from '../config/configuration.js';
import * as argon2 from 'argon2';

/**
 * Login and Session Integration Tests (P2-03)
 * 
 * Tests cover:
 * - Login success with phone/email
 * - Login failure with wrong password
 * - Account lockout after 10 failed attempts
 * - Token refresh with rotation
 * - Reuse detection (revokes token family)
 * - Logout (session revocation)
 * - Session list and revoke
 * - Password reset flow (revokes all sessions)
 */

describe('LoginService and SessionService (Integration)', () => {
  let loginService: LoginService;
  let sessionService: SessionService;
  let registrationService: RegistrationService;
  let prisma: PrismaService;
  let redis: Redis;

  const testUser = {
    name: 'Test User',
    phone: '+2348012345678',
    email: 'test@example.com',
    password: 'SecurePassword123!',
  };

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
        JwtModule.register({
          secret: process.env.JWT_SECRET || 'test-secret',
          signOptions: { expiresIn: '15m' },
        }),
      ],
      providers: [
        LoginService,
        SessionService,
        RegistrationService,
        OtpService,
        BlocklistService,
        {
          provide: 'IOtpDeliveryProvider',
          useValue: deliveryProvider,
        },
      ],
    }).compile();

    loginService = module.get<LoginService>(LoginService);
    sessionService = module.get<SessionService>(SessionService);
    registrationService = module.get<RegistrationService>(RegistrationService);
    prisma = module.get<PrismaService>(PrismaService);
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

    // Clean database and Redis
    await prisma.authSession.deleteMany({});
    await prisma.consentRecord.deleteMany({});
    await prisma.profile.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.blocklistEntry.deleteMany({});
    await prisma.policyVersion.deleteMany({});

    const keys = await redis.keys('otp:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    // Create policy versions
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

  describe('Login Flow', () => {
    it('should login successfully with phone', async () => {
      // Register user first
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      // Login
      const loginResult = await loginService.login(
        testUser.phone,
        testUser.password,
        'test-agent',
        '192.168.1.1',
      );

      expect(loginResult.userId).toBe(regResult.userId);
      expect(loginResult.accessToken).toBeDefined();
      expect(loginResult.refreshToken).toBeDefined();
      expect(loginResult.expiresIn).toBe(15 * 60); // 15 minutes

      // Verify access token is valid JWT
      const decoded = await sessionService.verifyAccessToken(loginResult.accessToken);
      expect(decoded.sub).toBe(regResult.userId);
      expect(decoded.aud).toBe('urgent-consumer');
    });

    it('should login successfully with email', async () => {
      await registrationService.register(
        {
          name: testUser.name,
          email: testUser.email,
          password: testUser.password,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      const loginResult = await loginService.login(
        testUser.email,
        testUser.password,
        'test-agent',
        '192.168.1.1',
      );

      expect(loginResult.accessToken).toBeDefined();
      expect(loginResult.refreshToken).toBeDefined();
    });

    it('should fail login with wrong password', async () => {
      await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      await expect(
        loginService.login(
          testUser.phone,
          'WrongPassword123!',
          'test-agent',
          '192.168.1.1',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should fail login with non-existent user', async () => {
      await expect(
        loginService.login(
          '+2348099999999',
          testUser.password,
          'test-agent',
          '192.168.1.1',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should update lastLoginAt on successful login', async () => {
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      await loginService.login(
        testUser.phone,
        testUser.password,
        'test-agent',
        '192.168.1.1',
      );

      const user = await prisma.user.findUnique({
        where: { id: regResult.userId },
      });

      expect(user!.lastLoginAt).toBeDefined();
      expect(user!.lastLoginAt).toBeInstanceOf(Date);
    });
  });

  describe('Failed Login Tracking and Lockout', () => {
    it('should track failed login attempts', async () => {
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      // Make 3 failed attempts
      for (let i = 0; i < 3; i++) {
        try {
          await loginService.login(
            testUser.phone,
            'WrongPassword',
            'test-agent',
            '192.168.1.1',
          );
        } catch (e) {
          // Expected to fail
        }
      }

      const user = await prisma.user.findUnique({
        where: { id: regResult.userId },
      });

      expect(user!.failedLoginCount).toBe(3);
    });

    it('should lock account after 10 failed attempts', async () => {
      await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      // Make 10 failed attempts
      for (let i = 0; i < 10; i++) {
        try {
          await loginService.login(
            testUser.phone,
            'WrongPassword',
            'test-agent',
            '192.168.1.1',
          );
        } catch (e) {
          // Expected to fail
        }
      }

      // 11th attempt should be blocked due to lockout
      await expect(
        loginService.login(
          testUser.phone,
          testUser.password, // Even with correct password
          'test-agent',
          '192.168.1.1',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reset failed count on successful login', async () => {
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      // Make 5 failed attempts
      for (let i = 0; i < 5; i++) {
        try {
          await loginService.login(
            testUser.phone,
            'WrongPassword',
            'test-agent',
            '192.168.1.1',
          );
        } catch (e) {
          // Expected
        }
      }

      // Successful login should reset count
      await loginService.login(
        testUser.phone,
        testUser.password,
        'test-agent',
        '192.168.1.1',
      );

      const user = await prisma.user.findUnique({
        where: { id: regResult.userId },
      });

      expect(user!.failedLoginCount).toBe(0);
      expect(user!.lockedUntil).toBeNull();
    });
  });

  describe('Token Refresh and Rotation', () => {
    it('should refresh tokens successfully', async () => {
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      const loginResult = await loginService.login(
        testUser.phone,
        testUser.password,
        'test-agent',
        '192.168.1.1',
      );

      // Refresh tokens
      const refreshResult = await sessionService.refreshSession(
        loginResult.refreshToken,
        'test-agent',
        '192.168.1.1',
      );

      expect(refreshResult.accessToken).toBeDefined();
      expect(refreshResult.refreshToken).toBeDefined();
      expect(refreshResult.refreshToken).not.toBe(loginResult.refreshToken);

      // New access token should be valid
      const decoded = await sessionService.verifyAccessToken(refreshResult.accessToken);
      expect(decoded.sub).toBe(regResult.userId);
    });

    it('should detect token reuse and revoke family', async () => {
      await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      const loginResult = await loginService.login(
        testUser.phone,
        testUser.password,
        'test-agent',
        '192.168.1.1',
      );

      // First refresh (rotates token)
      const refreshResult1 = await sessionService.refreshSession(
        loginResult.refreshToken,
        'test-agent',
        '192.168.1.1',
      );

      // Try to reuse old token (should detect reuse and revoke family)
      await expect(
        sessionService.refreshSession(
          loginResult.refreshToken,
          'test-agent',
          '192.168.1.1',
        ),
      ).rejects.toThrow('TOKEN_REUSE_DETECTED');

      // New token should also be revoked (family revocation)
      await expect(
        sessionService.refreshSession(
          refreshResult1.refreshToken,
          'test-agent',
          '192.168.1.1',
        ),
      ).rejects.toThrow();
    });

    it('should reject expired session', async () => {
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      const tokens = await sessionService.createSession(regResult.userId);
      const [sessionId] = tokens.refreshToken.split(':');

      // Manually expire the session
      await prisma.authSession.update({
        where: { id: sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        sessionService.refreshSession(tokens.refreshToken),
      ).rejects.toThrow('SESSION_EXPIRED');
    });
  });

  describe('Session Management', () => {
    it('should list user sessions', async () => {
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      // Create multiple sessions
      await sessionService.createSession(regResult.userId, 'agent1', '192.168.1.1');
      await sessionService.createSession(regResult.userId, 'agent2', '192.168.1.2');
      await sessionService.createSession(regResult.userId, 'agent3', '192.168.1.3');

      const sessions = await sessionService.listUserSessions(regResult.userId);

      expect(sessions).toHaveLength(3);
      expect(sessions[0].userAgent).toBeDefined();
      expect(sessions[0].ip).toBeDefined();
    });

    it('should revoke specific session', async () => {
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      const tokens = await sessionService.createSession(regResult.userId);
      const [sessionId] = tokens.refreshToken.split(':');

      await sessionService.revokeSession(sessionId);

      // Session should be revoked
      const session = await prisma.authSession.findUnique({
        where: { id: sessionId },
      });

      expect(session!.revokedAt).toBeDefined();
    });

    it('should revoke all user sessions', async () => {
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      // Create multiple sessions
      await sessionService.createSession(regResult.userId);
      await sessionService.createSession(regResult.userId);
      await sessionService.createSession(regResult.userId);

      await sessionService.revokeAllUserSessions(regResult.userId);

      const sessions = await prisma.authSession.findMany({
        where: { userId: regResult.userId, revokedAt: null },
      });

      expect(sessions).toHaveLength(0);
    });

    it('should logout (revoke session)', async () => {
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      const loginResult = await loginService.login(
        testUser.phone,
        testUser.password,
        'test-agent',
        '192.168.1.1',
      );

      const [sessionId] = loginResult.refreshToken.split(':');

      await loginService.logout(sessionId);

      // Session should be revoked
      const session = await prisma.authSession.findUnique({
        where: { id: sessionId },
      });

      expect(session!.revokedAt).toBeDefined();
    });
  });

  describe('Password Reset', () => {
    it('should change password and revoke all sessions', async () => {
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      // Create sessions
      await sessionService.createSession(regResult.userId);
      await sessionService.createSession(regResult.userId);

      // Change password
      const newPasswordHash = await argon2.hash('NewPassword456!', {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      });

      await prisma.user.update({
        where: { id: regResult.userId },
        data: { passwordHash: newPasswordHash },
      });

      // Revoke all sessions
      await sessionService.revokeAllUserSessions(regResult.userId);

      // All sessions should be revoked
      const sessions = await prisma.authSession.findMany({
        where: { userId: regResult.userId, revokedAt: null },
      });

      expect(sessions).toHaveLength(0);

      // Old password should not work
      await expect(
        loginService.login(
          testUser.phone,
          testUser.password,
          'test-agent',
          '192.168.1.1',
        ),
      ).rejects.toThrow(UnauthorizedException);

      // New password should work
      const loginResult = await loginService.login(
        testUser.phone,
        'NewPassword456!',
        'test-agent',
        '192.168.1.1',
      );

      expect(loginResult.accessToken).toBeDefined();
    });
  });

  describe('Account Status Checks', () => {
    it('should block login for suspended account', async () => {
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      // Suspend account
      await prisma.user.update({
        where: { id: regResult.userId },
        data: { status: 'SUSPENDED' },
      });

      await expect(
        loginService.login(
          testUser.phone,
          testUser.password,
          'test-agent',
          '192.168.1.1',
        ),
      ).rejects.toThrow('ACCOUNT_SUSPENDED');
    });

    it('should block login for deactivated account', async () => {
      const regResult = await registrationService.register(
        {
          ...testUser,
          consents: validConsents,
        },
        '192.168.1.1',
      );

      // Deactivate account
      await prisma.user.update({
        where: { id: regResult.userId },
        data: { status: 'DEACTIVATED' },
      });

      await expect(
        loginService.login(
          testUser.phone,
          testUser.password,
          'test-agent',
          '192.168.1.1',
        ),
      ).rejects.toThrow('ACCOUNT_DEACTIVATED');
    });
  });
});

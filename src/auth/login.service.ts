import { Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { SessionService } from './session.service.js';
import * as argon2 from 'argon2';

/**
 * Login Service (P2-03)
 * Per PRD §9.3:
 * - Verify passwords with Argon2id
 * - Track failed login attempts
 * - Temporary lockout after 10 failed attempts in 15 minutes
 * - Update lastLoginAt on successful login
 */

export interface LoginResult {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);
  private readonly MAX_FAILED_ATTEMPTS = 10;
  private readonly LOCKOUT_WINDOW_MINUTES = 15;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  /**
   * Login with email or phone and password
   */
  async login(
    identifier: string, // phone or email
    password: string,
    userAgent?: string,
    ip?: string,
  ): Promise<LoginResult> {
    // Find user by phone or email
    const isPhone = identifier.startsWith('+');
    const user = await this.prisma.user.findFirst({
      where: isPhone
        ? { phoneE164: identifier, deletedAt: null }
        : { email: identifier, deletedAt: null },
    });

    if (!user) {
      // Log failed attempt without revealing if user exists
      this.logger.warn({
        message: 'Login failed - user not found',
        identifier: this.maskIdentifier(identifier),
        ip,
      });
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    // Check if account is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remainingSeconds = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 1000,
      );
      this.logger.warn({
        message: 'Login failed - account locked',
        userId: user.id,
        remainingSeconds,
      });
      throw new UnauthorizedException({
        error: 'ACCOUNT_LOCKED',
        retryAfterSeconds: remainingSeconds,
      });
    }

    // Check if account is suspended or deactivated
    if (user.status === 'SUSPENDED') {
      throw new UnauthorizedException('ACCOUNT_SUSPENDED');
    }
    if (user.status === 'DEACTIVATED') {
      throw new UnauthorizedException('ACCOUNT_DEACTIVATED');
    }
    if (user.status === 'DELETED' || user.status === 'DELETION_PENDING') {
      throw new UnauthorizedException('ACCOUNT_DELETED');
    }

    // Verify password
    let passwordValid = false;
    try {
      passwordValid = await argon2.verify(user.passwordHash, password);
    } catch (error) {
      this.logger.error({
        message: 'Password verification error',
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    if (!passwordValid) {
      // Increment failed login count
      await this.handleFailedLogin(user.id);

      this.logger.warn({
        message: 'Login failed - invalid password',
        userId: user.id,
        failedCount: user.failedLoginCount + 1,
      });
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    // Successful login: reset failed count, update lastLoginAt
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    // Create session
    const tokens = await this.sessionService.createSession(
      user.id,
      userAgent,
      ip,
    );

    this.logger.log({
      message: 'Login successful',
      userId: user.id,
      identifier: this.maskIdentifier(identifier),
    });

    return {
      userId: user.id,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    };
  }

  /**
   * Handle failed login attempt
   * Increment counter and lock account if threshold reached
   */
  private async handleFailedLogin(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) return;

    const newFailedCount = user.failedLoginCount + 1;

    // Lock account if threshold reached
    if (newFailedCount >= this.MAX_FAILED_ATTEMPTS) {
      const lockedUntil = new Date(
        Date.now() + this.LOCKOUT_WINDOW_MINUTES * 60 * 1000,
      );

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: newFailedCount,
          lockedUntil,
        },
      });

      this.logger.warn({
        message: 'Account locked due to failed login attempts',
        userId,
        failedCount: newFailedCount,
        lockedUntil,
      });
    } else {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: newFailedCount,
        },
      });
    }
  }

  /**
   * Logout: revoke session
   */
  async logout(sessionId: string): Promise<void> {
    await this.sessionService.revokeSession(sessionId);
  }

  /**
   * Mask identifier for logging
   */
  private maskIdentifier(identifier: string): string {
    if (identifier.length <= 4) return '****';
    return identifier.slice(0, 2) + '****' + identifier.slice(-2);
  }
}

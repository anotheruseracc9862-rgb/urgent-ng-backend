import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service.js';
import { createHmac, randomBytes } from 'crypto';

/**
 * Session Service (P2-03)
 * Per PRD §9.3:
 * - 15-minute access JWT (audience: urgent-consumer)
 * - 30-day rotating refresh token (opaque, hashed, with family tracking)
 * - Reuse detection: replaying a rotated refresh token revokes the whole family
 * - Sessions stored in AuthSession table with userAgent, IP, expiry
 */

export interface AccessTokenPayload {
  sub: string; // userId
  aud: string; // 'urgent-consumer'
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string; // userId
  sessionId: string;
  familyId: string;
  type: 'refresh';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds until access token expires
}

export interface SessionInfo {
  id: string;
  familyId: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly accessTokenTtl: number;
  private readonly refreshTokenTtl: number;
  private readonly hmacSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {
    this.accessTokenTtl = this.config.getOrThrow<number>('jwt.accessTokenTtl');
    this.refreshTokenTtl = this.config.getOrThrow<number>('jwt.refreshTokenTtl');
    this.hmacSecret = this.config.getOrThrow<string>('security.hmacSecret');
  }

  /**
   * Create a new session with access and refresh tokens
   */
  async createSession(
    userId: string,
    userAgent?: string,
    ip?: string,
  ): Promise<TokenPair> {
    const familyId = randomBytes(16).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(refreshToken);

    const expiresAt = new Date(Date.now() + this.refreshTokenTtl * 1000);

    // Create session record
    const session = await this.prisma.authSession.create({
      data: {
        userId,
        familyId,
        tokenHash,
        userAgent: userAgent || null,
        ip: ip || null,
        expiresAt,
      },
    });

    // Generate access token
    const accessToken = await this.generateAccessToken(userId);

    this.logger.log({
      message: 'Session created',
      userId,
      sessionId: session.id,
      familyId,
    });

    return {
      accessToken,
      refreshToken: `${session.id}:${refreshToken}`,
      expiresIn: this.accessTokenTtl,
    };
  }

  /**
   * Refresh tokens with rotation
   * Implements reuse detection: if an already-rotated token is used, revoke the whole family
   */
  async refreshSession(
    refreshToken: string,
    userAgent?: string,
    ip?: string,
  ): Promise<TokenPair> {
    // Parse refresh token: sessionId:token
    const [sessionId, token] = refreshToken.split(':');
    if (!sessionId || !token) {
      throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
    }

    const tokenHash = this.hashToken(token);

    // Find session by ID
    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });

    if (!session) {
      throw new UnauthorizedException('SESSION_NOT_FOUND');
    }

    // Check if session is expired
    if (session.expiresAt < new Date()) {
      await this.revokeSession(sessionId);
      throw new UnauthorizedException('SESSION_EXPIRED');
    }

    // Check if session is revoked
    if (session.revokedAt) {
      throw new UnauthorizedException('SESSION_REVOKED');
    }

    // REUSE DETECTION: If token hash doesn't match, this token was already rotated
    if (session.tokenHash !== tokenHash) {
      this.logger.warn({
        message: 'Refresh token reuse detected - revoking family',
        userId: session.userId,
        sessionId: session.id,
        familyId: session.familyId,
      });

      // Revoke all sessions in this family
      await this.revokeFamilySessions(session.familyId);
      throw new UnauthorizedException('TOKEN_REUSE_DETECTED');
    }

    // Generate new refresh token
    const newRefreshToken = randomBytes(32).toString('hex');
    const newTokenHash = this.hashToken(newRefreshToken);
    const newExpiresAt = new Date(Date.now() + this.refreshTokenTtl * 1000);

    // Update session with new token hash (rotation)
    await this.prisma.authSession.update({
      where: { id: sessionId },
      data: {
        tokenHash: newTokenHash,
        expiresAt: newExpiresAt,
        userAgent: userAgent || session.userAgent,
        ip: ip || session.ip,
      },
    });

    // Generate new access token
    const accessToken = await this.generateAccessToken(session.userId);

    this.logger.log({
      message: 'Session refreshed',
      userId: session.userId,
      sessionId: session.id,
    });

    return {
      accessToken,
      refreshToken: `${sessionId}:${newRefreshToken}`,
      expiresIn: this.accessTokenTtl,
    };
  }

  /**
   * Revoke a specific session
   */
  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.authSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });

    this.logger.log({
      message: 'Session revoked',
      sessionId,
    });
  }

  /**
   * Revoke all sessions in a token family (reuse detection)
   */
  async revokeFamilySessions(familyId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: {
        familyId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    this.logger.warn({
      message: 'Token family revoked',
      familyId,
    });
  }

  /**
   * Revoke all sessions for a user
   */
  async revokeAllUserSessions(userId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    this.logger.log({
      message: 'All user sessions revoked',
      userId,
    });
  }

  /**
   * List all active sessions for a user
   */
  async listUserSessions(userId: string): Promise<SessionInfo[]> {
    const sessions = await this.prisma.authSession.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gte: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    return sessions.map((s) => ({
      id: s.id,
      familyId: s.familyId,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      lastUsedAt: s.createdAt, // Use createdAt as lastUsedAt since there's no updatedAt
    }));
  }

  /**
   * Generate access JWT token (15 minutes)
   */
  private async generateAccessToken(userId: string): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: userId,
      aud: 'urgent-consumer',
      type: 'access',
    };

    return this.jwtService.signAsync(payload, {
      expiresIn: this.accessTokenTtl,
      secret: this.config.getOrThrow<string>('jwt.secret'),
    });
  }

  /**
   * Verify and decode access token
   */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(
        token,
        {
          secret: this.config.getOrThrow<string>('jwt.secret'),
          audience: 'urgent-consumer',
        },
      );

      if (payload.type !== 'access') {
        throw new UnauthorizedException('INVALID_TOKEN_TYPE');
      }

      return payload;
    } catch (error) {
      throw new UnauthorizedException('INVALID_ACCESS_TOKEN');
    }
  }

  /**
   * Hash a refresh token using HMAC-SHA256
   */
  private hashToken(token: string): string {
    return createHmac('sha256', this.hmacSecret).update(token).digest('hex');
  }
}

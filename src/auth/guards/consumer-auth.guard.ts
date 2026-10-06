import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { SessionService } from '../session.service.js';
import { PrismaService } from '../../database/prisma.service.js';

/**
 * Consumer Authentication Guard (P2-04)
 * 
 * Validates JWT access tokens and attaches user to request.
 * Per PRD §9.3: validates audience 'urgent-consumer'.
 * 
 * Token sources (in order):
 * 1. Authorization header: Bearer <token>
 * 2. Cookie: ung_at
 * 
 * Attaches user object to request.user with:
 * - userId
 * - status
 * - phoneVerified
 * - emailVerified
 */

@Injectable()
export class ConsumerAuthGuard implements CanActivate {
  constructor(
    private readonly sessionService: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // Extract token from Authorization header or cookie
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('No access token provided');
    }

    // Verify token
    let payload;
    try {
      payload = await this.sessionService.verifyAccessToken(token);
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // Load user from database
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        status: true,
        phoneE164: true,
        phoneVerifiedAt: true,
        email: true,
        emailVerifiedAt: true,
        deletedAt: true,
      },
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('User not found');
    }

    // Attach user to request
    request.user = {
      userId: user.id,
      status: user.status,
      phoneVerified: !!user.phoneVerifiedAt,
      emailVerified: !!user.emailVerifiedAt,
    };

    return true;
  }

  /**
   * Extract token from Authorization header or cookie
   */
  private extractToken(request: Request): string | null {
    // Try Authorization header first
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // Try cookie
    const cookie = request.cookies?.ung_at;
    if (cookie) {
      return cookie;
    }

    return null;
  }
}

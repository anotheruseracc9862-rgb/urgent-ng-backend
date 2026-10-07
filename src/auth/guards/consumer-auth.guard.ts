import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../database/prisma.service.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { AUTH_REQUIRED } from '../../common/constants/error-codes.js';
import { SessionService } from '../session.service.js';
import { ACCESS_COOKIE } from '../auth.cookies.js';
import type { AuthenticatedUser } from '../decorators/current-user.decorator.js';

/**
 * Consumer authentication (Backend PRD 9.3, 9.4).
 *
 * Token sources, in order: `Authorization: Bearer <jwt>` (mobile and other clients),
 * then the `ung_at` cookie (web). The JWT must have audience `urgent-consumer`; an
 * admin token never passes. The user is re-read from the database on every request,
 * so a deleted account stops working at once.
 *
 * Any module that uses this guard must import AuthModule.
 */
@Injectable()
export class ConsumerAuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const token = this.extractToken(request);
    if (!token) {
      throw DomainException.of(AUTH_REQUIRED);
    }

    const payload = await this.sessions.verifyAccessToken(token);

    const user = await this.prisma.client.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true, phoneVerifiedAt: true, emailVerifiedAt: true },
    });
    if (!user || user.status === 'DELETED') {
      throw DomainException.of(AUTH_REQUIRED);
    }

    (request as Request & { user?: AuthenticatedUser }).user = {
      userId: user.id,
      sessionId: payload.sid,
      status: user.status,
      phoneVerified: user.phoneVerifiedAt !== null,
      emailVerified: user.emailVerifiedAt !== null,
    };
    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7).trim() || null;
    }
    const cookie = request.cookies?.[ACCESS_COOKIE];
    return typeof cookie === 'string' && cookie !== '' ? cookie : null;
  }
}

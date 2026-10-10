import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { AUTH_REQUIRED } from '../common/constants/error-codes.js';
import { ConsumerAuthGuard } from '../auth/guards/consumer-auth.guard.js';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { RealtimeTicketService } from './realtime-ticket.service.js';

/**
 * Authentication for `GET /events`: a one-time `?ticket=` (clients that cannot set headers), else
 * the normal consumer authentication (session cookie for web, Bearer for others). Account status is
 * checked after this by the usual guards.
 */
@Injectable()
export class SseAuthGuard implements CanActivate {
  constructor(
    private readonly tickets: RealtimeTicketService,
    private readonly consumer: ConsumerAuthGuard,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const ticket = request.query?.ticket;
    if (typeof ticket !== 'string' || ticket === '') {
      return this.consumer.canActivate(context);
    }
    const userId = await this.tickets.redeem(ticket);
    if (!userId) {
      throw DomainException.of(AUTH_REQUIRED);
    }
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, phoneVerifiedAt: true, emailVerifiedAt: true },
    });
    if (!user || user.status === 'DELETED') {
      throw DomainException.of(AUTH_REQUIRED);
    }
    request.user = {
      userId: user.id,
      sessionId: 'ticket',
      status: user.status,
      phoneVerified: user.phoneVerifiedAt !== null,
      emailVerified: user.emailVerifiedAt !== null,
    };
    return true;
  }
}

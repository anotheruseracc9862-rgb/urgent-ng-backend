import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../decorators/current-user.decorator.js';

/**
 * Restriction Guard (P2-04)
 * 
 * Per PRD §21: Check UserRestriction by type.
 * Restriction types from schema:
 * - OFFERING (cannot submit offers)
 * - MESSAGING (cannot send messages)
 * - POSTING (cannot post errands)
 * - RUNNING (cannot run errands)
 * - ACCOUNT_LOGIN (cannot login)
 * - ALL_MARKETPLACE (all marketplace actions blocked)
 * 
 * Must be used after ConsumerAuthGuard.
 * 
 * Usage:
 * ```typescript
 * @Post('/offers')
 * @UseGuards(ConsumerAuthGuard, AccountStatusGuard, RestrictionGuard)
 * @RequireNoRestriction('OFFERING')
 * async submitOffer() { ... }
 * ```
 */

export const RESTRICTION_TYPE_KEY = 'restrictionType';

export type RestrictionType =
  | 'OFFERING'
  | 'MESSAGING'
  | 'POSTING'
  | 'RUNNING'
  | 'ACCOUNT_LOGIN'
  | 'ALL_MARKETPLACE';

@Injectable()
export class RestrictionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const restrictionType = this.reflector.getAllAndOverride<RestrictionType>(
      RESTRICTION_TYPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If no restriction type is specified, allow
    if (!restrictionType) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // Check for active restrictions
    const activeRestriction = await this.prisma.userRestriction.findFirst({
      where: {
        userId: user.userId,
        type: restrictionType,
        OR: [
          { endsAt: null }, // Permanent restriction
          { endsAt: { gte: new Date() } }, // Temporary restriction not yet expired
        ],
      },
    });

    if (activeRestriction) {
      const message = this.getRestrictionMessage(restrictionType);
      const endsAt = activeRestriction.endsAt
        ? ` until ${activeRestriction.endsAt.toISOString()}`
        : '';

      throw new ForbiddenException(`${message}${endsAt}`);
    }

    return true;
  }

  private getRestrictionMessage(type: RestrictionType): string {
    const messages: Record<RestrictionType, string> = {
      OFFERING: 'You are restricted from submitting offers',
      MESSAGING: 'You are restricted from sending messages',
      POSTING: 'You are restricted from posting errands',
      RUNNING: 'You are restricted from running errands',
      ACCOUNT_LOGIN: 'Your account login is restricted',
      ALL_MARKETPLACE: 'Your marketplace access is restricted',
    };

    return messages[type];
  }
}

/**
 * Decorator to require no restriction of a specific type
 */
export const RequireNoRestriction = (type: RestrictionType) =>
  SetMetadata(RESTRICTION_TYPE_KEY, type);

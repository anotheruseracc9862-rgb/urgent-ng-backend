import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRestrictionType } from '@prisma/client';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { AUTH_REQUIRED, FORBIDDEN } from '../../common/constants/error-codes.js';
import { RestrictionService } from '../restriction.service.js';
import type { AuthenticatedUser } from '../decorators/current-user.decorator.js';

export const RESTRICTION_TYPE_KEY = 'restrictionType';

/**
 * Blocks users who have an active restriction of this type (or ALL_MARKETPLACE).
 * Runs after ConsumerAuthGuard. `@RequireNoRestriction('POSTING')`
 */
export const RequireNoRestriction = (type: UserRestrictionType) =>
  SetMetadata(RESTRICTION_TYPE_KEY, type);

@Injectable()
export class RestrictionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly restrictions: RestrictionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const type = this.reflector.getAllAndOverride<UserRestrictionType | undefined>(RESTRICTION_TYPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!type) {
      return true;
    }

    const user: AuthenticatedUser | undefined = context.switchToHttp().getRequest().user;
    if (!user) {
      throw DomainException.of(AUTH_REQUIRED);
    }

    const active = await this.restrictions.findActive(user.userId, type);
    if (active) {
      throw DomainException.of(FORBIDDEN, {
        message: 'This action is restricted on your account.',
        details: { restriction: active.type, endsAt: active.endsAt },
      });
    }
    return true;
  }
}

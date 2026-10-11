import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../database/prisma.service.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { ACCOUNT_SUSPENDED, AUTH_REQUIRED } from '../../common/constants/error-codes.js';
import type { AuthenticatedUser } from '../decorators/current-user.decorator.js';
import { CONTINUE_WHEN_SUSPENDED_KEY } from './account-status.guard.js';

/**
 * Suspension during an active assignment (Backend PRD 21.4). A route that is marked
 * `continueWhenSuspended` is open to a SUSPENDED account unless one of its active suspensions is
 * safety-critical, which stops execution actions at once. A lower-level suspension (the ladder's)
 * lets the user finish the errands they already have.
 *
 * Runs after AccountStatusGuard, which let a SUSPENDED account through only because the route
 * lists it. Has no effect on any other account status or on routes without the mark.
 */
@Injectable()
export class SuspensionPolicyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user: AuthenticatedUser | undefined = context.switchToHttp().getRequest().user;
    if (!user) {
      throw DomainException.of(AUTH_REQUIRED);
    }
    if (user.status !== 'SUSPENDED') {
      return true;
    }
    const marked = this.reflector.getAllAndOverride<boolean | undefined>(CONTINUE_WHEN_SUSPENDED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!marked) {
      return true;
    }

    const rows = await this.prisma.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one FROM enforcement_actions
      WHERE user_id = ${user.userId}::uuid
        AND type IN ('TEMPORARY_SUSPENSION'::"EnforcementActionType", 'PERMANENT_SUSPENSION'::"EnforcementActionType")
        AND status = 'ACTIVE'::"RestrictionStatus"
        AND safety_critical
        AND starts_at <= clock_timestamp()
        AND (ends_at IS NULL OR ends_at > clock_timestamp())
      LIMIT 1
    `;
    if (rows.length > 0) {
      throw DomainException.of(ACCOUNT_SUSPENDED, { details: { reason: 'SAFETY_CRITICAL' } });
    }
    return true;
  }
}

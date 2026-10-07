import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import {
  ACCOUNT_DEACTIVATED,
  ACCOUNT_DELETION_PENDING,
  ACCOUNT_SUSPENDED,
  AUTH_REQUIRED,
} from '../../common/constants/error-codes.js';
import type { AuthenticatedUser } from '../decorators/current-user.decorator.js';

export const ALLOWED_STATUSES_KEY = 'allowedAccountStatuses';

/**
 * Account-status guard (Backend PRD 9.5, INV-019). Runs after ConsumerAuthGuard.
 *
 * By default only an ACTIVE account passes: a deactivated, suspended or
 * deletion-pending user cannot perform marketplace actions. A route that those
 * users must still reach (reactivate, cancel deletion, read own data) lists the
 * statuses it allows with `@ConsumerAuth({ allow: [...] })`. DELETED never passes.
 */
@Injectable()
export class AccountStatusGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const user: AuthenticatedUser | undefined = context.switchToHttp().getRequest().user;
    if (!user) {
      throw DomainException.of(AUTH_REQUIRED);
    }

    const allowed = this.reflector.getAllAndOverride<string[] | undefined>(ALLOWED_STATUSES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (user.status === 'ACTIVE' || (allowed?.includes(user.status) && user.status !== 'DELETED')) {
      return true;
    }

    switch (user.status) {
      case 'DEACTIVATED':
        throw DomainException.of(ACCOUNT_DEACTIVATED);
      case 'SUSPENDED':
        throw DomainException.of(ACCOUNT_SUSPENDED);
      case 'DELETION_PENDING':
        throw DomainException.of(ACCOUNT_DELETION_PENDING);
      default:
        throw DomainException.of(AUTH_REQUIRED);
    }
  }
}

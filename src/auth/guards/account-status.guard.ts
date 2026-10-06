import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '../decorators/current-user.decorator.js';

/**
 * Account Status Guard (P2-04, INV-019)
 * 
 * Per PRD §9.5:
 * - DEACTIVATED users cannot post errands, submit offers, or start assignments
 * - SUSPENDED users are blocked based on enforcement restrictions
 * - DELETION_PENDING users can read permitted history but cannot perform marketplace actions
 * - DELETED users are blocked entirely
 * 
 * Must be used after ConsumerAuthGuard.
 */

export const ALLOW_DEACTIVATED_KEY = 'allowDeactivated';
export const ALLOW_DELETION_PENDING_KEY = 'allowDeletionPending';

@Injectable()
export class AccountStatusGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // Check for metadata that allows certain statuses
    const allowDeactivated = this.reflector.getAllAndOverride<boolean>(
      ALLOW_DEACTIVATED_KEY,
      [context.getHandler(), context.getClass()],
    );

    const allowDeletionPending = this.reflector.getAllAndOverride<boolean>(
      ALLOW_DELETION_PENDING_KEY,
      [context.getHandler(), context.getClass()],
    );

    // DELETED - always blocked
    if (user.status === 'DELETED') {
      throw new ForbiddenException('Account is deleted');
    }

    // SUSPENDED - always blocked from marketplace actions
    if (user.status === 'SUSPENDED') {
      throw new ForbiddenException('Account is suspended');
    }

    // DEACTIVATED - blocked unless explicitly allowed
    if (user.status === 'DEACTIVATED' && !allowDeactivated) {
      throw new ForbiddenException(
        'Account is deactivated. Reactivate to perform this action.',
      );
    }

    // DELETION_PENDING - blocked from marketplace actions unless explicitly allowed
    if (user.status === 'DELETION_PENDING' && !allowDeletionPending) {
      throw new ForbiddenException(
        'Account deletion is pending. Cancel deletion to perform this action.',
      );
    }

    return true;
  }
}

/**
 * Decorator to allow deactivated users on specific endpoints
 * (e.g., reading history, reactivation endpoint)
 */
export const AllowDeactivated = () =>
  Reflect.metadata(ALLOW_DEACTIVATED_KEY, true);

/**
 * Decorator to allow deletion-pending users on specific endpoints
 * (e.g., reading history, canceling deletion)
 */
export const AllowDeletionPending = () =>
  Reflect.metadata(ALLOW_DELETION_PENDING_KEY, true);

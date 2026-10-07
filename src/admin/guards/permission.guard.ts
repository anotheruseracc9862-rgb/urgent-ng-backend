import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { AUTH_REQUIRED, FORBIDDEN } from '../../common/constants/error-codes.js';
import type { AdminPermissionKey } from '../admin.permissions.js';
import type { AuthenticatedAdmin } from '../decorators/admin-auth.decorator.js';

export const REQUIRED_PERMISSIONS_KEY = 'requiredAdminPermissions';

/** Runs after AdminAuthGuard. Passes only when the admin holds every required permission. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<AdminPermissionKey[] | undefined>(REQUIRED_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const admin: AuthenticatedAdmin | undefined = context.switchToHttp().getRequest().admin;
    if (!admin) {
      throw DomainException.of(AUTH_REQUIRED);
    }

    const missing = required.filter((permission) => !admin.permissions.includes(permission));
    if (missing.length > 0) {
      throw DomainException.of(FORBIDDEN, { details: { missingPermissions: missing } });
    }
    return true;
  }
}

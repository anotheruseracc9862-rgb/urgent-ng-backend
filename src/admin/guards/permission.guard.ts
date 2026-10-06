import { Injectable, CanActivate, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthenticatedAdmin } from '../decorators/current-admin.decorator.js';

export const REQUIRE_PERMISSION_KEY = 'requirePermission';

/**
 * Decorator to require a specific permission
 * Use with AdminAuthGuard and PermissionGuard
 * 
 * @example
 * @RequirePermission('users.manage')
 * @UseGuards(AdminAuthGuard, PermissionGuard)
 * async manageUsers() { ... }
 */
export const RequirePermission = (permission: string) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permission);

/**
 * Permission-based authorization guard
 * Checks if admin has the required permission
 * Must be used after AdminAuthGuard
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermission = this.reflector.get<string>(
      REQUIRE_PERMISSION_KEY,
      context.getHandler(),
    );

    if (!requiredPermission) {
      // No permission required
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const admin = (request as any).admin as AuthenticatedAdmin | undefined;

    if (!admin) {
      throw new ForbiddenException('Admin not authenticated');
    }

    if (!admin.permissions.includes(requiredPermission)) {
      throw new ForbiddenException(
        `Missing required permission: ${requiredPermission}`,
      );
    }

    return true;
  }
}

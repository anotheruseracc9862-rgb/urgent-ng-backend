import { Injectable, CanActivate, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthenticatedAdmin } from '../decorators/current-admin.decorator.js';

export const REQUIRE_ROLE_KEY = 'requireRole';

/**
 * Decorator to require a specific role
 * Use with AdminAuthGuard and RoleGuard
 * 
 * @example
 * @RequireRole('SUPER_ADMIN')
 * @UseGuards(AdminAuthGuard, RoleGuard)
 * async superAdminOnly() { ... }
 */
export const RequireRole = (role: string) => SetMetadata(REQUIRE_ROLE_KEY, role);

/**
 * Role-based authorization guard
 * Checks if admin has the required role
 * Must be used after AdminAuthGuard
 */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRole = this.reflector.get<string>(
      REQUIRE_ROLE_KEY,
      context.getHandler(),
    );

    if (!requiredRole) {
      // No role required
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const admin = (request as any).admin as AuthenticatedAdmin | undefined;

    if (!admin) {
      throw new ForbiddenException('Admin not authenticated');
    }

    if (!admin.roles.includes(requiredRole)) {
      throw new ForbiddenException(`Missing required role: ${requiredRole}`);
    }

    return true;
  }
}

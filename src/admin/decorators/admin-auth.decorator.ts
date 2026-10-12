import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../guards/admin-auth.guard.js';
import { PermissionGuard, REQUIRED_PERMISSIONS_KEY } from '../guards/permission.guard.js';
import type { AdminPermissionKey } from '../admin.permissions.js';
import { ApiAdminAuth } from '../../common/api/api-docs.js';

/** The signed-in admin, attached to the request by AdminAuthGuard. */
export interface AuthenticatedAdmin {
  adminId: string;
  /** Session family id (the `sid` claim). */
  sessionId: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: AdminPermissionKey[];
}

export const CurrentAdmin = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedAdmin => {
  return ctx.switchToHttp().getRequest().admin;
});

/**
 * Require a signed-in admin holding ALL the listed permissions (none listed = any
 * signed-in admin). Authentication alone grants nothing sensitive (Backend PRD 24.3).
 *
 *   @AdminAuth('USERS_VIEW')
 *   @Get('users') ...
 *
 * The module that owns the controller must import AdminModule.
 */
export const AdminAuth = (...permissions: AdminPermissionKey[]) =>
  applyDecorators(SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions), UseGuards(AdminAuthGuard, PermissionGuard), ApiAdminAuth());

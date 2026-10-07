import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { AUTH_REQUIRED } from '../../common/constants/error-codes.js';
import { AdminSessionService } from '../admin-session.service.js';
import { AdminUserService } from '../admin-user.service.js';
import { ADMIN_ACCESS_COOKIE } from '../admin.cookies.js';
import type { AuthenticatedAdmin } from '../decorators/admin-auth.decorator.js';

/**
 * Admin authentication (Backend PRD 24.1). Separate trust boundary:
 *
 *  - the token is signed with a different key and has audience `urgent-admin`, so a
 *    consumer token never verifies here (and an admin token never verifies on consumer routes);
 *  - on EVERY request the admin must still be ACTIVE with MFA enabled, and the login
 *    (session family) must not be revoked or expired. Deactivating an admin, revoking
 *    a session or changing a role therefore takes effect on the next request.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly sessions: AdminSessionService,
    private readonly admins: AdminUserService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token) {
      throw DomainException.of(AUTH_REQUIRED);
    }

    const payload = await this.sessions.verifyAccessToken(token);

    const admin = await this.admins.findById(payload.sub);
    if (!admin || admin.status !== 'ACTIVE' || !admin.mfaEnabled) {
      throw DomainException.of(AUTH_REQUIRED);
    }
    if (!(await this.sessions.isFamilyActive(payload.sid, admin.id))) {
      throw DomainException.of(AUTH_REQUIRED);
    }

    const { roles, permissions } = await this.admins.rolesAndPermissions(admin.id);
    (request as Request & { admin?: AuthenticatedAdmin }).admin = {
      adminId: admin.id,
      sessionId: payload.sid,
      email: admin.email,
      displayName: admin.displayName,
      roles,
      permissions,
    };
    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7).trim() || null;
    }
    const cookie = request.cookies?.[ADMIN_ACCESS_COOKIE];
    return typeof cookie === 'string' && cookie !== '' ? cookie : null;
  }
}

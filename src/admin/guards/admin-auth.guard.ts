import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AdminUserService } from '../admin-user.service.js';
import type { Request } from 'express';
import type { AdminJwtPayload } from '../admin-auth.service.js';

/**
 * Admin authentication guard
 * Validates JWT with 'admin' type claim and loads admin with permissions
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly adminUserService: AdminUserService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // Extract token from cookie or Authorization header
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No admin token provided');
    }

    try {
      // Verify JWT
      const payload = await this.jwtService.verifyAsync<AdminJwtPayload>(token);

      // Verify it's an admin token
      if (payload.type !== 'admin') {
        throw new UnauthorizedException('Invalid token type');
      }

      // Load admin with fresh permissions
      const permissions = await this.adminUserService.getAdminPermissions(payload.sub);

      // Attach to request
      (request as any).admin = {
        adminId: payload.sub,
        email: payload.email,
        roles: payload.roles,
        permissions,
      };

      return true;
    } catch (error) {
      throw new UnauthorizedException('Invalid admin token');
    }
  }

  /**
   * Extract JWT from cookie (ung_admin_at) or Authorization header
   */
  private extractToken(request: Request): string | null {
    // Try cookie first
    if (request.cookies?.ung_admin_at) {
      return request.cookies.ung_admin_at;
    }

    // Fall back to Authorization header
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return null;
  }
}

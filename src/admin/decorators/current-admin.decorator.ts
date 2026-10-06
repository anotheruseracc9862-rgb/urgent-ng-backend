import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface AuthenticatedAdmin {
  adminId: string;
  email: string;
  roles: string[];
  permissions: string[];
}

/**
 * Extract authenticated admin from request
 * Populated by AdminAuthGuard
 */
export const CurrentAdmin = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AuthenticatedAdmin => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return (request as any).admin;
  },
);

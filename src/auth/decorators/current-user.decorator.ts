import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Current User Decorator (P2-04)
 * 
 * Extracts the authenticated user from the request.
 * Must be used with ConsumerAuthGuard.
 * 
 * Usage:
 * ```typescript
 * @Get('/profile')
 * @UseGuards(ConsumerAuthGuard)
 * async getProfile(@CurrentUser() user: AuthenticatedUser) {
 *   return user;
 * }
 * ```
 */

export interface AuthenticatedUser {
  userId: string;
  status: string;
  phoneVerified: boolean;
  emailVerified: boolean;
}

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

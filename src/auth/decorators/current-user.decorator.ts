import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** The signed-in consumer, attached to the request by ConsumerAuthGuard. */
export interface AuthenticatedUser {
  userId: string;
  /** Session family id (the `sid` claim): identifies this login on this device. */
  sessionId: string;
  status: 'ACTIVE' | 'DEACTIVATED' | 'SUSPENDED' | 'DELETION_PENDING' | 'DELETED';
  phoneVerified: boolean;
  emailVerified: boolean;
}

/**
 * ```ts
 * @Get('me')
 * @ConsumerAuth()
 * me(@CurrentUser() user: AuthenticatedUser) { ... }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    return ctx.switchToHttp().getRequest().user;
  },
);

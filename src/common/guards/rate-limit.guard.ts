import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';

/**
 * Custom rate limit guard that uses Redis for distributed rate limiting.
 * Extends NestJS ThrottlerGuard with named policy support.
 * Per PRD §6.6.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  constructor(
    options: any,
    storageService: any,
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
  ): Promise<void> {
    throw new ThrottlerException('RATE_LIMIT_EXCEEDED');
  }
}

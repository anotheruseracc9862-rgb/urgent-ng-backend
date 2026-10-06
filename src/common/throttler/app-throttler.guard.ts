import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DomainException } from '../exceptions/domain.exception.js';
import { RATE_LIMITED } from '../constants/error-codes.js';

/**
 * Global rate limit guard. Counts per authenticated user when one is attached
 * to the request, otherwise per client IP, and answers with the standard
 * RATE_LIMITED error envelope (HTTP 429).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.id ?? req.ip ?? 'unknown';
  }

  protected async throwThrottlingException(_context: ExecutionContext): Promise<void> {
    throw DomainException.of(RATE_LIMITED);
  }
}

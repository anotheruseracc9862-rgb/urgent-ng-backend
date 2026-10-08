import { ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DomainException } from '../exceptions/domain.exception.js';
import { RATE_LIMITED } from '../constants/error-codes.js';
import { SessionService } from '../../auth/session.service.js';
import { ACCESS_COOKIE } from '../../auth/auth.cookies.js';

/**
 * Global rate limit guard. Counts per signed-in user when the request carries a valid access
 * token, otherwise per client IP, and answers with the standard RATE_LIMITED error envelope
 * (HTTP 429).
 *
 * This guard runs before the route's own guards, so `request.user` is not set yet. It reads the
 * access token itself and checks the signature: a forged or expired token counts as anonymous and
 * falls back to the IP, so nobody can spend another user's budget by naming them. Users behind
 * one shared address (an office, a mobile carrier) no longer share a limit.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  // Property injection keeps the base class constructor untouched. Optional so small test
  // modules without the auth module still get IP-based limiting.
  @Optional()
  @Inject(SessionService)
  private readonly sessions?: SessionService;

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const token = this.accessToken(req);
    if (token && this.sessions) {
      try {
        const { sub } = await this.sessions.verifyAccessToken(token);
        return `user:${sub}`;
      } catch {
        // Not a valid token: counted as anonymous below.
      }
    }
    return `ip:${req.ip ?? 'unknown'}`;
  }

  private accessToken(req: Record<string, any>): string | null {
    const header = req.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7).trim() || null;
    }
    const cookie = req.cookies?.[ACCESS_COOKIE];
    return typeof cookie === 'string' && cookie !== '' ? cookie : null;
  }

  protected async throwThrottlingException(_context: ExecutionContext): Promise<void> {
    throw DomainException.of(RATE_LIMITED);
  }
}

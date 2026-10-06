import { Throttle } from '@nestjs/throttler';

/**
 * Rate limit policies per PRD §6.6.
 * 
 * Usage:
 * ```typescript
 * @RateLimit('auth')
 * async login() { ... }
 * 
 * @RateLimit('otp')
 * async sendOtp() { ... }
 * ```
 */

export type RateLimitPolicy = 
  | 'auth'          // Login attempts: 5 per minute per IP
  | 'otp'           // OTP requests: 10 per hour per IP
  | 'feed'          // Feed queries: 60 per minute
  | 'location'      // Location updates: 2 per minute (one per 30 s)
  | 'public-token'  // Public share link: 30 per minute
  | 'global';       // Global default: 300 per minute

/**
 * Policy configuration mapping.
 */
export const RATE_LIMIT_POLICIES: Record<RateLimitPolicy, { ttl: number; limit: number }> = {
  'auth': { ttl: 60_000, limit: 5 },
  'otp': { ttl: 3_600_000, limit: 10 },
  'feed': { ttl: 60_000, limit: 60 },
  'location': { ttl: 60_000, limit: 2 },
  'public-token': { ttl: 60_000, limit: 30 },
  'global': { ttl: 60_000, limit: 300 },       // 300 per minute (default)
};

/**
 * Apply a named rate limit policy to a route.
 * Uses Redis-backed throttler for distributed rate limiting.
 */
export function RateLimit(policy: RateLimitPolicy) {
  const config = RATE_LIMIT_POLICIES[policy];
  return Throttle({ default: config });
}

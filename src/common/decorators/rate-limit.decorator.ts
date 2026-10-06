import { SetMetadata } from '@nestjs/common';
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
  | 'auth'          // Login attempts: 5 per 15 minutes
  | 'otp'           // OTP requests: 3 per hour
  | 'feed'          // Feed queries: 30 per minute
  | 'location'      // Location updates: 2 per minute
  | 'public-token'  // Public token access: 10 per minute
  | 'global';       // Global default: 300 per minute

/**
 * Policy configuration mapping.
 */
export const RATE_LIMIT_POLICIES: Record<RateLimitPolicy, { ttl: number; limit: number }> = {
  'auth': { ttl: 900_000, limit: 5 },          // 5 per 15 min
  'otp': { ttl: 3600_000, limit: 3 },          // 3 per hour
  'feed': { ttl: 60_000, limit: 30 },          // 30 per minute
  'location': { ttl: 60_000, limit: 2 },       // 2 per minute
  'public-token': { ttl: 60_000, limit: 10 },  // 10 per minute
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

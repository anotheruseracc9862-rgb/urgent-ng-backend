import { SetMetadata } from '@nestjs/common';
import { REQUIRES_FLAG_KEY } from '../guards/feature-flag.guard.js';

/**
 * Decorator to require a feature flag to be enabled.
 * Used for kill switches per PRD §28.2.
 * 
 * The flag is checked in ConfigValue table and cached in Redis.
 * Flipping a flag blocks the route immediately without restart.
 * 
 * Usage:
 * ```typescript
 * @Post('register')
 * @RequiresFlag('registrations_enabled')
 * async register(@Body() dto: RegisterDto) {
 *   // Only executes if registrations_enabled = true
 * }
 * 
 * @Post('create')
 * @RequiresFlag('errand_posting_enabled')
 * async createErrand(@Body() dto: CreateErrandDto) {
 *   // Only executes if errand_posting_enabled = true
 * }
 * ```
 * 
 * Common kill switch flags:
 * - registrations_enabled
 * - errand_posting_enabled
 * - offers_enabled
 * - billing_enabled
 */
export const RequiresFlag = (flagKey: string) =>
  SetMetadata(REQUIRES_FLAG_KEY, flagKey);

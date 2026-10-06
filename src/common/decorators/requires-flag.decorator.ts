import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { FeatureFlagGuard, REQUIRES_FLAG_KEY } from '../guards/feature-flag.guard.js';
import type { BusinessConfig } from '../../config/business-config.service.js';

/**
 * Decorator to require a feature flag to be enabled.
 * Used for kill switches per PRD §28.2.
 *
 * The flag is a boolean BusinessConfig key (FEATURE_*), stored in the
 * ConfigValue table and cached in Redis. Flipping it blocks the route within
 * the cache TTL, without a restart. The decorator applies the guard itself.
 *
 * Usage:
 * ```typescript
 * @Post('register')
 * @RequiresFlag('FEATURE_REGISTRATIONS_ENABLED')
 * async register(@Body() dto: RegisterDto) {
 *   // Only executes if the flag is true
 * }
 * ```
 *
 * Kill switch flags: FEATURE_REGISTRATIONS_ENABLED, FEATURE_ERRAND_POSTING_ENABLED,
 * FEATURE_OFFERS_ENABLED, FEATURE_BILLING_ENABLED.
 */
export const RequiresFlag = (flagKey: keyof BusinessConfig) =>
  applyDecorators(SetMetadata(REQUIRES_FLAG_KEY, flagKey), UseGuards(FeatureFlagGuard));

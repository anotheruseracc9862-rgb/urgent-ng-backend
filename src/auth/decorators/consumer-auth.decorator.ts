import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import type { UserStatus } from '@prisma/client';
import { ConsumerAuthGuard } from '../guards/consumer-auth.guard.js';
import { ALLOWED_STATUSES_KEY, AccountStatusGuard } from '../guards/account-status.guard.js';
import { RestrictionGuard } from '../guards/restriction.guard.js';
import { PolicyAcceptanceGuard } from '../guards/policy-acceptance.guard.js';

export { RequireNoRestriction } from '../guards/restriction.guard.js';
export { RequiresPolicyAcceptance } from '../guards/policy-acceptance.guard.js';

/**
 * Require a signed-in consumer whose account status allows the route.
 *
 *   @ConsumerAuth()                                   ACTIVE accounts only (marketplace actions)
 *   @ConsumerAuth({ allow: ['DEACTIVATED'] })         also these statuses (reactivate, read own data)
 *
 * It runs, in order: authentication, account status, restriction check, policy
 * acceptance. The last two do nothing unless the route also has
 * `@RequireNoRestriction('POSTING')` or `@RequiresPolicyAcceptance()`.
 *
 * The module that owns the controller must import AuthModule.
 */
export const ConsumerAuth = (options: { allow?: UserStatus[] } = {}) =>
  applyDecorators(
    SetMetadata(ALLOWED_STATUSES_KEY, options.allow ?? []),
    UseGuards(ConsumerAuthGuard, AccountStatusGuard, RestrictionGuard, PolicyAcceptanceGuard),
  );

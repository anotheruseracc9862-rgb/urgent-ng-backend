import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import type { UserStatus } from '@prisma/client';
import { ConsumerAuthGuard } from '../guards/consumer-auth.guard.js';
import { ALLOWED_STATUSES_KEY, AccountStatusGuard, CONTINUE_WHEN_SUSPENDED_KEY } from '../guards/account-status.guard.js';
import { SuspensionPolicyGuard } from '../guards/suspension-policy.guard.js';
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
 *   @ConsumerAuth({ continueWhenSuspended: true })    ACTIVE accounts, and a SUSPENDED account unless its
 *                                                     suspension is safety-critical (Backend PRD 21.4):
 *                                                     a lower-level suspension lets the user finish the
 *                                                     errands they already have
 *
 * The module that owns the controller must import AuthModule.
 */
export const ConsumerAuth = (options: { allow?: UserStatus[]; continueWhenSuspended?: boolean } = {}) => {
  const allow = options.continueWhenSuspended ? [...new Set<UserStatus>([...(options.allow ?? []), 'SUSPENDED'])] : (options.allow ?? []);
  return applyDecorators(
    SetMetadata(ALLOWED_STATUSES_KEY, allow),
    SetMetadata(CONTINUE_WHEN_SUSPENDED_KEY, options.continueWhenSuspended === true),
    UseGuards(ConsumerAuthGuard, AccountStatusGuard, SuspensionPolicyGuard, RestrictionGuard, PolicyAcceptanceGuard),
  );
};

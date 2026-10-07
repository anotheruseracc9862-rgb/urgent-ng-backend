import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { AUTH_REQUIRED, POLICY_ACCEPTANCE_REQUIRED } from '../../common/constants/error-codes.js';
import { PolicyService } from '../policy.service.js';
import type { AuthenticatedUser } from '../decorators/current-user.decorator.js';

/**
 * Policy-acceptance guard (Backend PRD 9.4, 9.6). Runs after ConsumerAuthGuard.
 * Blocks with POLICY_ACCEPTANCE_REQUIRED, listing the policy versions to accept, while
 * the user has not accepted the current version of a required policy whose publisher
 * asked for re-acceptance. Does nothing unless the route has `@RequiresPolicyAcceptance()`.
 */
export const REQUIRES_POLICY_ACCEPTANCE_KEY = 'requiresPolicyAcceptance';

/** Mark a route (or controller) as needing the latest required policies accepted. */
export const RequiresPolicyAcceptance = () => SetMetadata(REQUIRES_POLICY_ACCEPTANCE_KEY, true);

@Injectable()
export class PolicyAcceptanceGuard implements CanActivate {
  constructor(
    private readonly policies: PolicyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(
      REQUIRES_POLICY_ACCEPTANCE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) {
      return true;
    }

    const user: AuthenticatedUser | undefined = context.switchToHttp().getRequest().user;
    if (!user) {
      throw DomainException.of(AUTH_REQUIRED);
    }

    const outstanding = await this.policies.outstandingFor(user.userId);
    if (outstanding.length > 0) {
      throw DomainException.of(POLICY_ACCEPTANCE_REQUIRED, {
        details: {
          requiredPolicies: outstanding.map((policy) => ({
            type: policy.type,
            version: policy.version,
            publishedAt: policy.publishedAt,
          })),
        },
      });
    }
    return true;
  }
}

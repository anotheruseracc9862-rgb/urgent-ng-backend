import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../decorators/current-user.decorator.js';

/**
 * Policy Acceptance Guard (P2-04)
 * 
 * Per PRD §9.6:
 * - Publishing a new policy version can require re-acceptance before the user continues
 * - Returns POLICY_ACCEPTANCE_REQUIRED when a required policy version has not been accepted
 * 
 * Must be used after ConsumerAuthGuard.
 * 
 * Usage:
 * ```typescript
 * @Post('/errands')
 * @UseGuards(ConsumerAuthGuard, AccountStatusGuard, PolicyAcceptanceGuard)
 * async postErrand() { ... }
 * ```
 */

@Injectable()
export class PolicyAcceptanceGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // Get all policy versions that require re-acceptance
    const requiredPolicies = await this.prisma.policyVersion.findMany({
      where: {
        requiresReacceptance: true,
      },
    });

    if (requiredPolicies.length === 0) {
      return true;
    }

    // Check if user has accepted all required policies
    const userConsents = await this.prisma.consentRecord.findMany({
      where: {
        userId: user.userId,
        withdrawnAt: null,
      },
    });

    // Build map of user's accepted versions by type
    const acceptedVersions = new Map<string, string>();
    for (const consent of userConsents) {
      acceptedVersions.set(consent.consentType, consent.documentVersion);
    }

    // Find any required policies that haven't been accepted
    const missingPolicies = requiredPolicies.filter((policy) => {
      const acceptedVersion = acceptedVersions.get(policy.type);
      return !acceptedVersion || acceptedVersion !== policy.version;
    });

    if (missingPolicies.length > 0) {
      throw new ForbiddenException({
        error: 'POLICY_ACCEPTANCE_REQUIRED',
        message: 'You must accept the latest policy versions to continue',
        requiredPolicies: missingPolicies.map((p) => ({
          type: p.type,
          version: p.version,
          publishedAt: p.publishedAt,
        })),
      });
    }

    return true;
  }
}

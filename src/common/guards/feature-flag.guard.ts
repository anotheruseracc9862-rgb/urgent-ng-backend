import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessConfigService } from '../../config/business-config.service.js';

export const REQUIRES_FLAG_KEY = 'requiresFlag';

/**
 * Kill switch guard (P1-08)
 * Blocks routes when a feature flag is disabled.
 * Per PRD §28.2.
 * 
 * Usage:
 * ```typescript
 * @Post('register')
 * @RequiresFlag('registrations_enabled')
 * async register() { ... }
 * ```
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: BusinessConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flagKey = this.reflector.get<string>(
      REQUIRES_FLAG_KEY,
      context.getHandler(),
    );

    if (!flagKey) {
      // No flag requirement, allow
      return true;
    }

    // Check if flag is enabled
    // Cast to any since kill switch flags are added dynamically
    const isEnabled = await this.configService.get(flagKey as any);

    if (isEnabled !== true && isEnabled !== 'true') {
      throw new ServiceUnavailableException({
        code: 'FEATURE_DISABLED',
        message: `This feature is temporarily disabled`,
        flagKey, // Include for debugging (remove in production)
      });
    }

    return true;
  }
}

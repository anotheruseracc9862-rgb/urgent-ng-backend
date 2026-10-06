import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessConfigService, BusinessConfig } from '../../config/business-config.service.js';
import { DomainException } from '../exceptions/domain.exception.js';
import { FEATURE_DISABLED } from '../constants/error-codes.js';

export const REQUIRES_FLAG_KEY = 'requiresFlag';

/**
 * Kill switch guard (P1-08)
 * Blocks routes when a feature flag is disabled. Per PRD section 28.2.
 * Apply it with `@RequiresFlag('FEATURE_OFFERS_ENABLED')` on a route or class.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: BusinessConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flagKey = this.reflector.getAllAndOverride<keyof BusinessConfig | undefined>(
      REQUIRES_FLAG_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!flagKey) {
      return true;
    }

    const enabled = await this.configService.get(flagKey);
    if (enabled !== true) {
      throw DomainException.of(FEATURE_DISABLED);
    }

    return true;
  }
}

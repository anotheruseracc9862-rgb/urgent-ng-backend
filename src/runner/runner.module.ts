import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { EntitlementsModule } from '../entitlements/entitlements.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { RunnerController } from './runner.controller.js';
import { RunnerProfileService } from './runner-profile.service.js';
import { RunnerEligibilityService } from './runner-eligibility.service.js';

/**
 * Runner profile and eligibility (Backend PRD 10.1, 10.5). Modules that act on runners (feed,
 * offers) import this module and call `RunnerEligibilityService`.
 */
@Module({
  imports: [AuthModule, ConfigStoreModule, VerificationModule, EntitlementsModule],
  controllers: [RunnerController],
  providers: [RunnerProfileService, RunnerEligibilityService],
  exports: [RunnerProfileService, RunnerEligibilityService],
})
export class RunnerModule {}

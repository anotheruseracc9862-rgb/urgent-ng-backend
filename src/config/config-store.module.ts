import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BusinessConfigService } from './business-config.service.js';
import { PricingService } from './pricing.service.js';

/**
 * Admin-editable business configuration and prices (Backend PRD section 32).
 * Global so any module can inject BusinessConfigService / PricingService.
 */
@Global()
@Module({
  imports: [AuditModule],
  providers: [BusinessConfigService, PricingService],
  exports: [BusinessConfigService, PricingService],
})
export class ConfigStoreModule {}

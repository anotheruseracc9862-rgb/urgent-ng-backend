import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CommonModule } from '../common/common.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { EntitlementAdminService } from './entitlement-admin.service.js';
import { EntitlementService } from './entitlement.service.js';
import { OFFER_LIMIT_POLICY, OfferLimitService } from './offer-limit.service.js';
import { ProEntitlementPolicy } from './pro-entitlement.policy.js';

/**
 * Runner entitlement logic for the offer-limit rules in Backend PRD section 13.6.
 * The module stays intentionally small and dependency-light so it can be reused by the
 * runner eligibility and offer submission flows without a circular dependency.
 */
@Module({
  imports: [AuditModule, CommonModule, ConfigStoreModule, DatabaseModule],
  providers: [ProEntitlementPolicy, { provide: OFFER_LIMIT_POLICY, useExisting: ProEntitlementPolicy }, OfferLimitService, EntitlementService, EntitlementAdminService],
  exports: [OfferLimitService, EntitlementService, EntitlementAdminService],
})
export class EntitlementsModule {}

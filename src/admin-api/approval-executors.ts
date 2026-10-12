import { Injectable, OnModuleInit } from '@nestjs/common';
import { ApprovalExecutorRegistry } from '../admin/framework/approval.service.js';
import { EnforcementService } from '../enforcement/enforcement.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { PricingService } from '../config/pricing.service.js';
import { AdminAccountsService } from './accounts/admin-accounts.js';

/**
 * What runs when the second admin approves each kind of four-eyes request (Backend PRD 24.5).
 * Each executor calls the same domain service a single-admin action would, so state machines,
 * events and notifications behave identically.
 */
@Injectable()
export class AdminApprovalExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ApprovalExecutorRegistry,
    private readonly enforcement: EnforcementService,
    private readonly config: BusinessConfigService,
    private readonly pricing: PricingService,
    private readonly accounts: AdminAccountsService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      kind: 'PERMANENT_SUSPENSION',
      execute: async (payload, ctx) => {
        const userId = String(payload.userId);
        const action = await this.enforcement.adminApply(
          {
            userId,
            type: 'PERMANENT_SUSPENSION',
            reason: ctx.reason.text ?? ctx.reason.code,
            caseRef: typeof payload.caseRef === 'string' ? payload.caseRef : undefined,
            causeEventIds: Array.isArray(payload.causeEventIds) ? (payload.causeEventIds as string[]) : undefined,
          },
          { adminId: ctx.approvedBy, reviewId: typeof payload.reviewId === 'string' ? payload.reviewId : undefined },
        );
        return { enforcementActionId: action.id, userId };
      },
    });

    // A kill switch or a configuration value: both are one config version, effective now or later.
    const applyConfig = async (payload: Record<string, unknown>, ctx: { approvedBy: string }) => {
      const key = String(payload.key);
      const effectiveFrom = typeof payload.effectiveFrom === 'string' ? new Date(payload.effectiveFrom) : undefined;
      await this.config.set(key as never, payload.value as never, effectiveFrom, ctx.approvedBy);
      return { key, value: payload.value, effectiveFrom: effectiveFrom?.toISOString() ?? null };
    };
    this.registry.register({ kind: 'KILL_SWITCH', execute: (payload, ctx) => applyConfig(payload, ctx) });
    this.registry.register({ kind: 'CONFIG_CHANGE', execute: (payload, ctx) => applyConfig(payload, ctx) });

    // A price is a new price version; orders keep the version they were made at.
    this.registry.register({
      kind: 'PRICE_CHANGE',
      execute: async (payload, ctx) => {
        if (payload.type === 'CONFIG') {
          return applyConfig(payload, ctx);
        }
        const effectiveFrom = new Date(String(payload.effectiveFrom));
        // The request may have waited; a price never starts in the past.
        const startsAt = effectiveFrom.getTime() < Date.now() ? new Date(Date.now() + 1000) : effectiveFrom;
        const version = await this.pricing.createPriceVersion(
          String(payload.productId),
          Number(payload.amountKobo),
          startsAt,
          typeof payload.notes === 'string' ? payload.notes : undefined,
          ctx.approvedBy,
        );
        return { priceVersionId: version.id, productId: payload.productId, amountKobo: Number(payload.amountKobo), effectiveFrom: startsAt.toISOString() };
      },
    });

    // An admin's roles, or a role's permissions: the two changes that grant power.
    this.registry.register({
      kind: 'ADMIN_ROLE_CHANGE',
      execute: async (payload, ctx) => {
        if (payload.type === 'ROLE_PERMISSIONS') {
          return this.accounts.applyRolePermissions(String(payload.roleId), (payload.permissions as string[]) ?? [], ctx.approvedBy);
        }
        return this.accounts.applyRoles(String(payload.adminId), (payload.roles as string[]) ?? [], ctx.approvedBy);
      },
    });
  }
}

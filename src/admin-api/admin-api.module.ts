import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminModule } from '../admin/admin.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { EnforcementModule } from '../enforcement/enforcement.module.js';
import { BadgesModule } from '../badges/badges.module.js';
import { ReliabilityModule } from '../reliability/reliability.module.js';
import { AdminPager } from './common/admin-page.js';
import { AdminApprovalExecutors } from './approval-executors.js';
import { AdminUsersController } from './users/admin-users.controller.js';
import { AdminUsersService } from './users/admin-users.service.js';
import { AdminVerificationController, AdminVerificationService } from './verification/admin-verification.js';
import { AdminEnforcementController, AdminEnforcementService } from './enforcement/admin-enforcement.js';
import { AdminErrandsController, AdminErrandsService } from './errands/admin-errands.js';
import { ErrandsModule } from '../errands/errands.module.js';
import { OffersModule } from '../offers/offers.module.js';
import { AdminCasesController, AdminCasesService } from './cases/admin-cases.js';
import { DisputesModule } from '../disputes/disputes.module.js';
import { ReportsModule } from '../reports/reports.module.js';
import { RatingsModule } from '../ratings/ratings.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { BoostsModule } from '../boosts/boosts.module.js';
import { EntitlementsModule } from '../entitlements/entitlements.module.js';
import { AdminBillingController, AdminBillingService } from './billing/admin-billing.js';
import { AdminConfigController, AdminConfigService } from './config/admin-config.js';
import { AdminOperationsController, AdminOperationsService } from './operations/admin-operations.js';
import { AdminAuditAnalyticsController, AdminAnalyticsService, AdminAuditService } from './audit/admin-audit-analytics.js';
import { AuditModule } from '../audit/audit.module.js';
import { AdminAccountsController, AdminAccountsService } from './accounts/admin-accounts.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { RiskModule } from '../risk/risk.module.js';

/**
 * The admin API (Phase 11, Backend PRD 24.4 and 30.9). Every controller here is guarded by
 * `@AdminAuth(permission)`, takes a reason on every write, and changes state only through the
 * domain services (state machines, events and notifications behave as for a user action).
 */
@Module({
  imports: [AdminModule, AuthModule, DatabaseModule, VerificationModule, EnforcementModule, BadgesModule, ReliabilityModule, ErrandsModule, OffersModule, DisputesModule, ReportsModule, RatingsModule, BillingModule, SubscriptionsModule, BoostsModule, EntitlementsModule, NotificationsModule, QueueModule, RiskModule, AuditModule],
  controllers: [AdminUsersController, AdminVerificationController, AdminEnforcementController, AdminErrandsController, AdminCasesController, AdminBillingController, AdminConfigController, AdminOperationsController, AdminAuditAnalyticsController, AdminAccountsController],
  providers: [
    AdminPager,
    AdminApprovalExecutors,
    AdminUsersService,
    AdminVerificationService,
    AdminEnforcementService,
    AdminErrandsService,
    AdminCasesService,
    AdminBillingService,
    AdminConfigService,
    AdminOperationsService,
    AdminAuditService,
    AdminAnalyticsService,
    AdminAccountsService,
  ],
})
export class AdminApiModule {}

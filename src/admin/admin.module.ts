import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CommonModule } from '../common/common.module.js';
import { AdminActionService } from './framework/admin-action.service.js';
import { SensitiveAccessService } from './framework/sensitive-access.service.js';
import { ApprovalExecutorRegistry, ApprovalService } from './framework/approval.service.js';
import { ApprovalController } from './framework/approval.controller.js';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminSessionService } from './admin-session.service.js';
import { AdminAuthEventService } from './admin-auth-event.service.js';
import { AdminUserService } from './admin-user.service.js';
import { AdminAuthGuard } from './guards/admin-auth.guard.js';
import { PermissionGuard } from './guards/permission.guard.js';

/**
 * Admin identity and RBAC (Backend PRD section 24). A separate trust boundary from
 * consumer auth. Modules with admin endpoints import this module and use
 * `@AdminAuth('PERMISSION_KEY')`.
 */
@Module({
  imports: [AuthModule, AuditModule, CommonModule, JwtModule.register({})], // AuthModule: PasswordService
  controllers: [AdminAuthController, ApprovalController],
  providers: [
    AdminAuthEventService,
    AdminUserService,
    AdminSessionService,
    AdminAuthService,
    AdminAuthGuard,
    PermissionGuard,
    AdminActionService,
    SensitiveAccessService,
    ApprovalExecutorRegistry,
    ApprovalService,
  ],
  exports: [
    AdminUserService,
    AdminSessionService,
    AdminAuthEventService,
    AdminAuthGuard,
    PermissionGuard,
    AdminActionService,
    SensitiveAccessService,
    ApprovalExecutorRegistry,
    ApprovalService,
  ],
})
export class AdminModule {}

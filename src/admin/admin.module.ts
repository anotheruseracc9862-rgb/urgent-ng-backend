import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module.js';
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
  imports: [AuthModule, JwtModule.register({})], // AuthModule: PasswordService
  controllers: [AdminAuthController],
  providers: [
    AdminAuthEventService,
    AdminUserService,
    AdminSessionService,
    AdminAuthService,
    AdminAuthGuard,
    PermissionGuard,
  ],
  exports: [AdminUserService, AdminSessionService, AdminAuthEventService, AdminAuthGuard, PermissionGuard],
})
export class AdminModule {}

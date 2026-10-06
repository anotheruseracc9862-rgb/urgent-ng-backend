import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../database/database.module.js';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminUserService } from './admin-user.service.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminAuthGuard } from './guards/admin-auth.guard.js';
import { PermissionGuard } from './guards/permission.guard.js';
import { RoleGuard } from './guards/role.guard.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    JwtModule.register({}), // Uses global config
  ],
  controllers: [AdminAuthController],
  providers: [
    AdminUserService,
    AdminAuthService,
    AdminAuthGuard,
    PermissionGuard,
    RoleGuard,
  ],
  exports: [
    AdminUserService,
    AdminAuthService,
    AdminAuthGuard,
    PermissionGuard,
    RoleGuard,
  ],
})
export class AdminModule {}

import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service.js';
import { AdminUserService } from './admin-user.service.js';
import { AdminStatus, AdminAuthEventType } from '@prisma/client';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';

export interface AdminJwtPayload {
  sub: string; // admin ID
  email: string;
  roles: string[];
  type: 'admin';
}

@Injectable()
export class AdminAuthService {
  private readonly accessTokenTtl: number;
  private readonly refreshTokenTtl: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminUserService: AdminUserService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {
    this.accessTokenTtl = this.config.get('jwt.accessTokenTtl', 900); // 15 minutes
    this.refreshTokenTtl = this.config.get('jwt.refreshTokenTtl', 2592000); // 30 days
  }

  /**
   * Admin login with email and password
   * Returns access token and refresh token
   */
  async login(email: string, password: string, userAgent: string, ipAddress: string) {
    // Find admin
    const admin = await this.adminUserService.findByEmail(email);

    if (!admin) {
      // Record failed login event
      await this.recordAuthEvent(
        null,
        email,
        AdminAuthEventType.LOGIN_FAILED,
        false,
        'ADMIN_NOT_FOUND',
        ipAddress,
        userAgent,
      );
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check account status
    if (admin.status !== AdminStatus.ACTIVE) {
      await this.recordAuthEvent(
        admin.id,
        email,
        AdminAuthEventType.LOGIN_FAILED,
        false,
        `ACCOUNT_${admin.status}`,
        ipAddress,
        userAgent,
      );
      throw new UnauthorizedException(`Account is ${admin.status.toLowerCase()}`);
    }

    // Check if locked
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      await this.recordAuthEvent(
        admin.id,
        email,
        AdminAuthEventType.LOGIN_FAILED,
        false,
        'ACCOUNT_LOCKED',
        ipAddress,
        userAgent,
      );
      throw new UnauthorizedException('Account is temporarily locked');
    }

    // Verify password
    const passwordValid = await argon2.verify(admin.passwordHash, password);

    if (!passwordValid) {
      // Increment failed login count
      const failedCount = admin.failedLoginCount + 1;
      const lockedUntil = failedCount >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null; // Lock for 15 minutes

      await this.prisma.admin.update({
        where: { id: admin.id },
        data: {
          failedLoginCount: failedCount,
          lockedUntil,
        },
      });

      await this.recordAuthEvent(
        admin.id,
        email,
        AdminAuthEventType.LOGIN_FAILED,
        false,
        'INVALID_PASSWORD',
        ipAddress,
        userAgent,
      );

      throw new UnauthorizedException('Invalid credentials');
    }

    // TODO: Verify TOTP if enabled (P2-06 enhancement)
    // if (admin.totpEnabled) {
    //   if (!totpCode) throw new BadRequestException('TOTP code required');
    //   const valid = verifyTOTP(admin.totpSecret, totpCode);
    //   if (!valid) throw new UnauthorizedException('Invalid TOTP code');
    // }

    // Reset failed login count and update last login
    await this.prisma.admin.update({
      where: { id: admin.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    // Generate tokens
    const roles = admin.roleAssignments.map((a) => a.role.name);
    const { accessToken, refreshToken } = await this.generateTokens(admin.id, email, roles);

    // Create session
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.adminSession.create({
      data: {
        adminId: admin.id,
        tokenHash,
        userAgent,
        ip: ipAddress,
        expiresAt: new Date(Date.now() + this.refreshTokenTtl * 1000),
      },
    });

    // Record successful login
    await this.recordAuthEvent(
      admin.id,
      email,
      AdminAuthEventType.LOGIN,
      true,
      null,
      ipAddress,
      userAgent,
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTokenTtl,
      adminId: admin.id,
    };
  }

  /**
   * Refresh admin access token
   */
  async refreshToken(refreshToken: string, userAgent: string, ipAddress: string) {
    const tokenHash = this.hashToken(refreshToken);

    // Find session
    const session = await this.prisma.adminSession.findUnique({
      where: { tokenHash },
      include: { admin: true },
    });

    if (!session || session.revokedAt) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // Check admin status
    if (session.admin.status !== AdminStatus.ACTIVE) {
      throw new UnauthorizedException('Admin account is not active');
    }

    // Get admin with roles
    const admin = await this.adminUserService.findById(session.adminId);
    if (!admin) {
      throw new UnauthorizedException('Admin not found');
    }

    // Generate new access token (refresh token stays the same)
    const roles = admin.roleAssignments.map((a) => a.role.name);
    const accessToken = await this.generateAccessToken(admin.id, admin.email, roles);

    return {
      accessToken,
      expiresIn: this.accessTokenTtl,
    };
  }

  /**
   * Logout (revoke session)
   */
  async logout(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);

    await this.prisma.adminSession.update({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });

    return { success: true };
  }

  /**
   * Generate access and refresh tokens
   */
  private async generateTokens(adminId: string, email: string, roles: string[]) {
    const payload: AdminJwtPayload = {
      sub: adminId,
      email,
      roles,
      type: 'admin',
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: this.accessTokenTtl,
    });

    // Refresh token is just a random string
    const refreshToken = crypto.randomBytes(32).toString('hex');

    return { accessToken, refreshToken };
  }

  /**
   * Generate access token only
   */
  private async generateAccessToken(adminId: string, email: string, roles: string[]) {
    const payload: AdminJwtPayload = {
      sub: adminId,
      email,
      roles,
      type: 'admin',
    };

    return this.jwtService.signAsync(payload, {
      expiresIn: this.accessTokenTtl,
    });
  }

  /**
   * Hash token for storage
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Record authentication event
   */
  private async recordAuthEvent(
    adminId: string | null,
    email: string,
    event: AdminAuthEventType,
    success: boolean,
    reason: string | null,
    ip: string,
    userAgent: string,
  ) {
    await this.prisma.adminAuthEvent.create({
      data: {
        adminId,
        email,
        event,
        success,
        reason,
        ip,
        userAgent,
      },
    });
  }
}

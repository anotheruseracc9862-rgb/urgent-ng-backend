import { Controller, Post, Body, HttpCode, HttpStatus, Ip, Headers, Res, UseGuards, Get } from '@nestjs/common';
import type { Response } from 'express';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminLoginDto, AdminRefreshDto } from './dto/admin-auth.dto.js';
import { AdminAuthGuard } from './guards/admin-auth.guard.js';
import { CurrentAdmin, type AuthenticatedAdmin } from './decorators/current-admin.decorator.js';

/**
 * Admin Authentication Controller
 * Separate from consumer auth with different JWT audience and cookie
 */
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  /**
   * Admin login
   * POST /admin/auth/login
   * Sets HTTP-only cookie 'ung_admin_at'
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: AdminLoginDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.adminAuthService.login(
      dto.email,
      dto.password,
      userAgent,
      ipAddress,
    );

    // Set HTTP-only cookie for web admin
    res.cookie('ung_admin_at', result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: result.expiresIn * 1000,
    });

    return {
      success: true,
      data: {
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        adminId: result.adminId,
      },
    };
  }

  /**
   * Refresh admin access token
   * POST /admin/auth/refresh
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: AdminRefreshDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.adminAuthService.refreshToken(
      dto.refreshToken,
      userAgent,
      ipAddress,
    );

    // Update cookie
    res.cookie('ung_admin_at', result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: result.expiresIn * 1000,
    });

    return {
      success: true,
      data: {
        expiresIn: result.expiresIn,
      },
    };
  }

  /**
   * Logout
   * POST /admin/auth/logout
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body() body: { refreshToken: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.adminAuthService.logout(body.refreshToken);

    // Clear cookie
    res.clearCookie('ung_admin_at');

    return {
      success: true,
      message: 'Logged out successfully',
    };
  }

  /**
   * Get current admin info
   * GET /admin/auth/me
   */
  @Get('me')
  @UseGuards(AdminAuthGuard)
  async getMe(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return {
      success: true,
      data: admin,
    };
  }
}

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { DeviceType } from '@prisma/client';

@Injectable()
export class DeviceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register or update a device for push notifications
   * Per PRD §9.8
   */
  async registerDevice(
    userId: string,
    deviceType: DeviceType,
    pushToken: string,
  ) {
    // Verify user exists
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if device already exists with this push token
    const existingDevice = await this.prisma.device.findUnique({
      where: { pushToken },
    });

    if (existingDevice) {
      // Update existing device
      if (existingDevice.userId !== userId) {
        // Token moved to different user - update ownership
        const device = await this.prisma.device.update({
          where: { pushToken },
          data: {
            userId,
            type: deviceType,
            active: true,
            lastSeenAt: new Date(),
          },
        });

        return {
          success: true,
          message: 'Device updated successfully',
          deviceId: device.id,
        };
      } else {
        // Same user - just update timestamp
        const device = await this.prisma.device.update({
          where: { pushToken },
          data: {
            active: true,
            lastSeenAt: new Date(),
          },
        });

        return {
          success: true,
          message: 'Device refreshed successfully',
          deviceId: device.id,
        };
      }
    }

    // Create new device
    const device = await this.prisma.device.create({
      data: {
        userId,
        type: deviceType,
        pushToken,
        active: true,
        lastSeenAt: new Date(),
      },
    });

    return {
      success: true,
      message: 'Device registered successfully',
      deviceId: device.id,
    };
  }

  /**
   * Deactivate a device (soft delete)
   */
  async deactivateDevice(userId: string, deviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (device.userId !== userId) {
      throw new BadRequestException('Device does not belong to this user');
    }

    await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        active: false,
        deletedAt: new Date(),
      },
    });

    return {
      success: true,
      message: 'Device deactivated successfully',
    };
  }

  /**
   * List user's devices
   */
  async listDevices(userId: string) {
    const devices = await this.prisma.device.findMany({
      where: {
        userId,
        deletedAt: null,
      },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        type: true,
        active: true,
        lastSeenAt: true,
        createdAt: true,
        // Don't expose push token
      },
    });

    return devices;
  }

  /**
   * Get active devices for a user (for push notification targeting)
   */
  async getActiveDevices(userId: string) {
    return this.prisma.device.findMany({
      where: {
        userId,
        active: true,
        deletedAt: null,
      },
      select: {
        id: true,
        type: true,
        pushToken: true,
      },
    });
  }

  /**
   * Update device last seen timestamp
   */
  async updateLastSeen(deviceId: string) {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date() },
    });
  }
}

import { Injectable } from '@nestjs/common';
import { DeviceType, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';

export interface DeviceView {
  id: string;
  type: DeviceType;
  active: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
}

/**
 * Push devices (Backend PRD A.3). A push token belongs to one live device row. When
 * the same token is registered by another account (shared phone, new owner) it moves
 * to that account, so the previous owner stops getting this device's notifications.
 */
@Injectable()
export class DeviceService {
  constructor(private readonly prisma: PrismaService) {}

  async register(userId: string, type: DeviceType, pushToken: string): Promise<DeviceView> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.prisma.client.device.findFirst({ where: { pushToken } });
      try {
        const device = existing
          ? await this.prisma.client.device.update({
              where: { id: existing.id },
              data: { userId, type, active: true, lastSeenAt: new Date() },
            })
          : await this.prisma.client.device.create({
              data: { userId, type, pushToken, active: true, lastSeenAt: new Date() },
            });
        return this.view(device);
      } catch (error) {
        // Two registrations of the same token raced: the unique index let one win, retry as an update.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
      }
    }
    throw new Error('Could not register the device');
  }

  async list(userId: string): Promise<DeviceView[]> {
    const devices = await this.prisma.client.device.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return devices.map((device) => this.view(device));
  }

  /** Remove one of the user's own devices (soft delete). */
  async remove(userId: string, deviceId: string): Promise<void> {
    const device = await this.prisma.client.device.findFirst({ where: { id: deviceId, userId } });
    if (!device) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    await this.prisma.client.device.delete({ where: { id: deviceId } });
  }

  /** Active push tokens for a user (used by the notification module later). */
  async activeTokens(userId: string): Promise<Array<{ id: string; type: DeviceType; pushToken: string }>> {
    return this.prisma.client.device.findMany({
      where: { userId, active: true },
      select: { id: true, type: true, pushToken: true },
    });
  }

  private view(device: {
    id: string;
    type: DeviceType;
    active: boolean;
    lastSeenAt: Date | null;
    createdAt: Date;
  }): DeviceView {
    return {
      id: device.id,
      type: device.type,
      active: device.active,
      lastSeenAt: device.lastSeenAt,
      createdAt: device.createdAt,
    };
  }
}

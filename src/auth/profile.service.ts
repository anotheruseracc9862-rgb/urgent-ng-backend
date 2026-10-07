import { Injectable } from '@nestjs/common';
import type { StartMode } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';

export interface MeView {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  phoneVerified: boolean;
  email: string | null;
  emailVerified: boolean;
  status: string;
  startMode: StartMode | null;
  photoMediaId: string | null;
  deletionScheduledAt: Date | null;
  createdAt: Date;
}

export interface PublicProfileView {
  id: string;
  firstName: string;
  lastInitial: string;
  photoMediaId: string | null;
  memberSince: Date;
}

/**
 * The signed-in user's own profile, and the small public view of another user.
 * Nothing sensitive (password hash, lockout state, deletion internals of others) is selected.
 */
@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string): Promise<MeView> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        firstName: true,
        lastName: true,
        phoneE164: true,
        phoneVerifiedAt: true,
        email: true,
        emailVerifiedAt: true,
        status: true,
        startMode: true,
        deletionScheduledAt: true,
        createdAt: true,
        profile: { select: { photoMediaId: true } },
      },
    });
    if (!user) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return {
      id: user.id,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phoneE164,
      phoneVerified: user.phoneVerifiedAt !== null,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      status: user.status,
      startMode: user.startMode,
      photoMediaId: user.profile?.photoMediaId ?? null,
      deletionScheduledAt: user.deletionScheduledAt,
      createdAt: user.createdAt,
    };
  }

  /** `name` replaces first and last name together; `startMode` is a preference only (Backend PRD 9.1). */
  async updateMe(userId: string, changes: { name?: string; startMode?: StartMode }): Promise<MeView> {
    const data: { name?: string; firstName?: string; lastName?: string; startMode?: StartMode } = {};
    if (changes.name !== undefined) {
      const [firstName, ...rest] = changes.name.trim().split(/\s+/);
      data.name = changes.name.trim();
      data.firstName = firstName;
      data.lastName = rest.join(' ') || firstName;
    }
    if (changes.startMode !== undefined) {
      data.startMode = changes.startMode;
    }

    if (Object.keys(data).length > 0) {
      const result = await this.prisma.client.user.updateMany({ where: { id: userId }, data });
      if (result.count === 0) {
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }
    }
    return this.getMe(userId);
  }

  async getPublic(userId: string): Promise<PublicProfileView> {
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId, status: { in: ['ACTIVE', 'DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        createdAt: true,
        profile: { select: { photoMediaId: true } },
      },
    });
    if (!user) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return {
      id: user.id,
      firstName: user.firstName,
      lastInitial: user.lastName.charAt(0).toUpperCase(),
      photoMediaId: user.profile?.photoMediaId ?? null,
      memberSince: user.createdAt,
    };
  }
}

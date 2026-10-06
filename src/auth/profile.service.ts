import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { UserStatus } from '@prisma/client';

export interface UpdateProfileData {
  firstName?: string;
  lastName?: string;
}

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get user profile
   * Returns User + Profile data
   */
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      id: user.id,
      phoneE164: user.phoneE164,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phoneVerifiedAt: user.phoneVerifiedAt,
      emailVerifiedAt: user.emailVerifiedAt,
      status: user.status,
      createdAt: user.createdAt,
      profile: user.profile,
    };
  }

  /**
   * Update user profile
   * Updates firstName/lastName on User model
   */
  async updateProfile(userId: string, data: UpdateProfileData) {
    // Validate user exists
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Validate name fields (1-50 chars, no special chars except spaces, hyphens, apostrophes)
    if (data.firstName !== undefined) {
      this.validateName(data.firstName, 'firstName');
    }
    if (data.lastName !== undefined) {
      this.validateName(data.lastName, 'lastName');
    }

    // Update User fields (firstName, lastName)
    const userUpdates: { firstName?: string; lastName?: string } = {};
    if (data.firstName !== undefined) userUpdates.firstName = data.firstName;
    if (data.lastName !== undefined) userUpdates.lastName = data.lastName;

    // Execute update if there are changes
    if (Object.keys(userUpdates).length > 0) {
      await this.prisma.user.update({
        where: { id: userId },
        data: userUpdates,
      });
    }

    // Return updated profile
    return this.getProfile(userId);
  }

  /**
   * Validate name fields
   * 1-50 chars, only letters, spaces, hyphens, apostrophes
   */
  private validateName(name: string, field: string) {
    if (!name || name.trim().length === 0) {
      throw new BadRequestException(`${field} cannot be empty`);
    }

    if (name.length < 1 || name.length > 50) {
      throw new BadRequestException(`${field} must be between 1 and 50 characters`);
    }

    // Allow letters (any Unicode letter), spaces, hyphens, apostrophes
    const namePattern = /^[\p{L}\s'\-]+$/u;
    if (!namePattern.test(name)) {
      throw new BadRequestException(
        `${field} can only contain letters, spaces, hyphens, and apostrophes`,
      );
    }
  }
}

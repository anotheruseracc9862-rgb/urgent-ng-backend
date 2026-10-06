import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { UserStatus } from '@prisma/client';

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deactivate user account
   * Sets status to DEACTIVATED, tracks deactivatedAt timestamp
   * Per PRD §9.7
   */
  async deactivateAccount(userId: string, reason?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.status === UserStatus.DEACTIVATED) {
      throw new BadRequestException('Account is already deactivated');
    }

    if (user.status === UserStatus.DELETED) {
      throw new BadRequestException('Cannot deactivate a deleted account');
    }

    // Update status to DEACTIVATED
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        status: UserStatus.DEACTIVATED,
        deactivatedAt: new Date(),
      },
    });

    // TODO: Audit log entry with reason (Phase 1 audit module)
    // await this.auditService.log({
    //   userId,
    //   action: 'account.deactivated',
    //   metadata: { reason },
    // });

    return {
      success: true,
      message: 'Account deactivated successfully',
    };
  }

  /**
   * Reactivate user account
   * Sets status back to ACTIVE, clears deactivatedAt
   * Per PRD §9.7
   */
  async reactivateAccount(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.status === UserStatus.ACTIVE) {
      throw new BadRequestException('Account is already active');
    }

    if (user.status === UserStatus.DELETED) {
      throw new BadRequestException('Cannot reactivate a deleted account');
    }

    if (user.status === UserStatus.DELETION_PENDING) {
      throw new BadRequestException(
        'Cannot reactivate an account with pending deletion. Cancel deletion request first.',
      );
    }

    // Update status to ACTIVE
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        status: UserStatus.ACTIVE,
        deactivatedAt: null,
      },
    });

    // TODO: Audit log entry (Phase 1 audit module)
    // await this.auditService.log({
    //   userId,
    //   action: 'account.reactivated',
    // });

    return {
      success: true,
      message: 'Account reactivated successfully',
    };
  }

  /**
   * Request account deletion
   * Sets status to DELETION_PENDING, tracks deletionRequestedAt
   * Actual deletion happens via scheduled job after 30 days (Phase 3)
   * Per PRD §9.7
   */
  async requestDeletion(userId: string, reason?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.status === UserStatus.DELETED) {
      throw new BadRequestException('Account is already deleted');
    }

    if (user.status === UserStatus.DELETION_PENDING) {
      throw new BadRequestException('Deletion request is already pending');
    }

    // Update status to DELETION_PENDING
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        status: UserStatus.DELETION_PENDING,
        deletionRequestedAt: new Date(),
      },
    });

    // TODO: Audit log entry with reason (Phase 1 audit module)
    // await this.auditService.log({
    //   userId,
    //   action: 'account.deletion_requested',
    //   metadata: { reason },
    // });

    return {
      success: true,
      message: 'Account deletion requested. You have 30 days to cancel before permanent deletion.',
      deletionScheduledAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
    };
  }

  /**
   * Cancel account deletion request
   * Sets status back to previous state (ACTIVE or DEACTIVATED based on deactivatedAt)
   * Clears deletionRequestedAt
   * Per PRD §9.7
   */
  async cancelDeletion(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.status !== UserStatus.DELETION_PENDING) {
      throw new BadRequestException('No deletion request to cancel');
    }

    // Determine what status to restore
    // If there's a deactivatedAt timestamp, restore to DEACTIVATED, otherwise ACTIVE
    const restoredStatus = user.deactivatedAt ? UserStatus.DEACTIVATED : UserStatus.ACTIVE;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        status: restoredStatus,
        deletionRequestedAt: null,
      },
    });

    // TODO: Audit log entry (Phase 1 audit module)
    // await this.auditService.log({
    //   userId,
    //   action: 'account.deletion_cancelled',
    // });

    return {
      success: true,
      message: 'Account deletion cancelled successfully',
      restoredStatus,
    };
  }
}

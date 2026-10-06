import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class BlockService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Block a user (bidirectional blocking)
   * Both users cannot see each other's errands or interact
   * Per PRD §9.8
   */
  async blockUser(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) {
      throw new BadRequestException('Cannot block yourself');
    }

    // Check if already blocked
    const existingBlock = await this.prisma.block.findUnique({
      where: {
        blockerId_blockedId: {
          blockerId,
          blockedId,
        },
      },
    });

    if (existingBlock) {
      throw new BadRequestException('User is already blocked');
    }

    // Verify both users exist
    const [blocker, blocked] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: blockerId } }),
      this.prisma.user.findUnique({ where: { id: blockedId } }),
    ]);

    if (!blocker || !blocked) {
      throw new NotFoundException('User not found');
    }

    // Create block
    const block = await this.prisma.block.create({
      data: {
        blockerId,
        blockedId,
      },
    });

    return {
      success: true,
      message: 'User blocked successfully',
      blockId: block.id,
    };
  }

  /**
   * Unblock a user
   */
  async unblockUser(blockerId: string, blockedId: string) {
    const block = await this.prisma.block.findUnique({
      where: {
        blockerId_blockedId: {
          blockerId,
          blockedId,
        },
      },
    });

    if (!block) {
      throw new NotFoundException('Block not found');
    }

    await this.prisma.block.delete({
      where: {
        blockerId_blockedId: {
          blockerId,
          blockedId,
        },
      },
    });

    return {
      success: true,
      message: 'User unblocked successfully',
    };
  }

  /**
   * Check if user A has blocked user B
   */
  async isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    const block = await this.prisma.block.findUnique({
      where: {
        blockerId_blockedId: {
          blockerId,
          blockedId,
        },
      },
    });

    return !!block;
  }

  /**
   * Check if there's a bidirectional block between two users
   * (either direction counts as blocked)
   */
  async areUsersBlocked(userId1: string, userId2: string): Promise<boolean> {
    const blocks = await this.prisma.block.findMany({
      where: {
        OR: [
          { blockerId: userId1, blockedId: userId2 },
          { blockerId: userId2, blockedId: userId1 },
        ],
      },
    });

    return blocks.length > 0;
  }

  /**
   * List all users blocked by this user
   */
  async listBlocks(userId: string) {
    const blocks = await this.prisma.block.findMany({
      where: { blockerId: userId, deletedAt: null },
      include: {
        blocked: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return blocks.map((block) => ({
      blockId: block.id,
      blockedUser: block.blocked,
      createdAt: block.createdAt,
    }));
  }
}

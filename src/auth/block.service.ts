import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';

export interface BlockedUserView {
  userId: string;
  firstName: string;
  lastInitial: string;
  blockedAt: Date;
}

/**
 * Blocking (Backend PRD 9.7). A block stops new direct messages and new offers
 * between the pair; it never deletes records. Unblocking is a soft delete, so the
 * pair can be blocked again later.
 */
@Injectable()
export class BlockService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent: blocking someone already blocked succeeds. */
  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'You cannot block yourself.' });
    }

    const target = await this.prisma.client.user.findFirst({
      where: { id: blockedId, status: { not: 'DELETED' } },
      select: { id: true },
    });
    if (!target) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }

    await this.prisma.$executeRaw`
      INSERT INTO blocks (blocker_id, blocked_id)
      VALUES (${blockerId}::uuid, ${blockedId}::uuid)
      ON CONFLICT (blocker_id, blocked_id) WHERE deleted_at IS NULL DO NOTHING
    `;
  }

  /** Idempotent: unblocking someone not blocked succeeds. */
  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.prisma.client.block.deleteMany({ where: { blockerId, blockedId } });
  }

  async list(blockerId: string): Promise<BlockedUserView[]> {
    const blocks = await this.prisma.client.block.findMany({
      where: { blockerId },
      include: { blocked: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return blocks.map((block) => ({
      userId: block.blocked.id,
      firstName: block.blocked.firstName,
      lastInitial: block.blocked.lastName.charAt(0).toUpperCase(),
      blockedAt: block.createdAt,
    }));
  }

  /** True when either user has blocked the other. */
  async existsBetween(userA: string, userB: string): Promise<boolean> {
    const count = await this.prisma.client.block.count({
      where: {
        OR: [
          { blockerId: userA, blockedId: userB },
          { blockerId: userB, blockedId: userA },
        ],
      },
    });
    return count > 0;
  }
}

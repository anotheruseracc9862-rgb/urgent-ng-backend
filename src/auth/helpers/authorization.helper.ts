import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

/**
 * Authorization Helpers (P2-04)
 * 
 * Per PRD §9.4: Authorization considers:
 * - Identity
 * - Resource ownership
 * - Errand relationship (requester, runner with offer, assigned runner)
 * - Assignment status
 * - Verification status
 * - Account status
 * - Entitlements
 * - Enforcement restrictions
 * 
 * Helper pattern for ownership and relationship checks.
 */

export class AuthorizationHelper {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Check if user owns a resource
   * Throws ForbiddenException if not owner
   */
  async requireOwnership(
    userId: string,
    resourceType: 'errand' | 'offer' | 'profile',
    resourceId: string,
  ): Promise<void> {
    let isOwner = false;

    switch (resourceType) {
      case 'errand':
        const errand = await this.prisma.$queryRaw<any[]>`
          SELECT 1 FROM errands 
          WHERE id = ${resourceId}::uuid 
          AND requester_id = ${userId}::uuid
          AND deleted_at IS NULL
          LIMIT 1
        `;
        isOwner = errand.length > 0;
        break;

      case 'offer':
        const offer = await this.prisma.$queryRaw<any[]>`
          SELECT 1 FROM offers 
          WHERE id = ${resourceId}::uuid 
          AND runner_id = ${userId}::uuid
          AND deleted_at IS NULL
          LIMIT 1
        `;
        isOwner = offer.length > 0;
        break;

      case 'profile':
        isOwner = userId === resourceId;
        break;
    }

    if (!isOwner) {
      throw new ForbiddenException(
        `You do not have permission to access this ${resourceType}`,
      );
    }
  }

  /**
   * Check if user is the requester of an errand
   */
  async isErrandRequester(userId: string, errandId: string): Promise<boolean> {
    const errand = await this.prisma.$queryRaw<any[]>`
      SELECT 1 FROM errands 
      WHERE id = ${errandId}::uuid 
      AND requester_id = ${userId}::uuid
      AND deleted_at IS NULL
      LIMIT 1
    `;
    return errand.length > 0;
  }

  /**
   * Check if user has an active offer on an errand
   */
  async hasOfferOnErrand(userId: string, errandId: string): Promise<boolean> {
    const offer = await this.prisma.$queryRaw<any[]>`
      SELECT 1 FROM offers 
      WHERE errand_id = ${errandId}::uuid 
      AND runner_id = ${userId}::uuid
      AND status = 'ACTIVE'
      AND deleted_at IS NULL
      LIMIT 1
    `;
    return offer.length > 0;
  }

  /**
   * Check if user is the assigned runner on an errand
   */
  async isAssignedRunner(userId: string, errandId: string): Promise<boolean> {
    const assignment = await this.prisma.$queryRaw<any[]>`
      SELECT 1 FROM assignments 
      WHERE errand_id = ${errandId}::uuid 
      AND runner_id = ${userId}::uuid
      AND status IN ('PENDING', 'ACCEPTED', 'IN_PROGRESS')
      AND deleted_at IS NULL
      LIMIT 1
    `;
    return assignment.length > 0;
  }

  /**
   * Check if user is a participant in an errand (requester, has offer, or assigned)
   */
  async isErrandParticipant(userId: string, errandId: string): Promise<boolean> {
    const isRequester = await this.isErrandRequester(userId, errandId);
    if (isRequester) return true;

    const hasOffer = await this.hasOfferOnErrand(userId, errandId);
    if (hasOffer) return true;

    const isRunner = await this.isAssignedRunner(userId, errandId);
    return isRunner;
  }

  /**
   * Require user to be errand participant
   * Throws ForbiddenException if not participant
   */
  async requireErrandParticipant(
    userId: string,
    errandId: string,
  ): Promise<void> {
    const isParticipant = await this.isErrandParticipant(userId, errandId);
    if (!isParticipant) {
      throw new ForbiddenException(
        'You do not have permission to access this errand',
      );
    }
  }

  /**
   * Check if user has blocked another user
   */
  async hasBlocked(userId: string, otherUserId: string): Promise<boolean> {
    const block = await this.prisma.block.findFirst({
      where: {
        blockerId: userId,
        blockedId: otherUserId,
        deletedAt: null,
      },
    });
    return block !== null;
  }

  /**
   * Check if user is blocked by another user
   */
  async isBlockedBy(userId: string, otherUserId: string): Promise<boolean> {
    return this.hasBlocked(otherUserId, userId);
  }

  /**
   * Check if there's any block between two users (either direction)
   */
  async isBlockRelationship(
    userId: string,
    otherUserId: string,
  ): Promise<boolean> {
    const hasBlocked = await this.hasBlocked(userId, otherUserId);
    if (hasBlocked) return true;

    const isBlocked = await this.isBlockedBy(userId, otherUserId);
    return isBlocked;
  }

  /**
   * Require no block relationship between users
   * Throws ForbiddenException if blocked
   */
  async requireNoBlock(userId: string, otherUserId: string): Promise<void> {
    const isBlocked = await this.isBlockRelationship(userId, otherUserId);
    if (isBlocked) {
      throw new ForbiddenException('This action is not available');
    }
  }
}

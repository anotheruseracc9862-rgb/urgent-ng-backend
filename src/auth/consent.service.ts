import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { ConsentType } from '@prisma/client';

@Injectable()
export class ConsentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record user consent to a policy version
   * Per PRD §9.8
   */
  async recordConsent(
    userId: string,
    consentType: ConsentType,
    documentVersion: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    // Verify user exists
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Create consent record
    const consent = await this.prisma.consentRecord.create({
      data: {
        userId,
        consentType,
        documentVersion,
        acceptedAt: new Date(),
        ipAddress,
        userAgent,
      },
    });

    return {
      success: true,
      message: 'Consent recorded successfully',
      consent: {
        id: consent.id,
        consentType: consent.consentType,
        documentVersion: consent.documentVersion,
        acceptedAt: consent.acceptedAt,
      },
    };
  }

  /**
   * Get user's consent history
   */
  async getUserConsents(userId: string) {
    const consents = await this.prisma.consentRecord.findMany({
      where: { userId },
      orderBy: { acceptedAt: 'desc' },
    });

    return consents.map((consent) => ({
      id: consent.id,
      consentType: consent.consentType,
      documentVersion: consent.documentVersion,
      acceptedAt: consent.acceptedAt,
      withdrawnAt: consent.withdrawnAt,
    }));
  }

  /**
   * Get latest consent for each type
   */
  async getLatestConsents(userId: string) {
    // Get all consents grouped by type
    const consents = await this.prisma.consentRecord.findMany({
      where: { userId },
      orderBy: { acceptedAt: 'desc' },
    });

    // Group by consent type and take the most recent
    const latestByType = new Map();
    for (const consent of consents) {
      const type = consent.consentType;
      if (!latestByType.has(type) && !consent.withdrawnAt) {
        latestByType.set(type, consent);
      }
    }

    return Array.from(latestByType.values()).map((consent) => ({
      id: consent.id,
      consentType: consent.consentType,
      documentVersion: consent.documentVersion,
      acceptedAt: consent.acceptedAt,
    }));
  }

  /**
   * Withdraw consent (soft delete - mark as withdrawn)
   */
  async withdrawConsent(userId: string, consentId: string) {
    const consent = await this.prisma.consentRecord.findUnique({
      where: { id: consentId },
    });

    if (!consent) {
      throw new NotFoundException('Consent record not found');
    }

    if (consent.userId !== userId) {
      throw new BadRequestException('Consent does not belong to this user');
    }

    if (consent.withdrawnAt) {
      throw new BadRequestException('Consent already withdrawn');
    }

    await this.prisma.consentRecord.update({
      where: { id: consentId },
      data: { withdrawnAt: new Date() },
    });

    return {
      success: true,
      message: 'Consent withdrawn successfully',
    };
  }
}

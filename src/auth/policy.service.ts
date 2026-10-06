import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { ConsentType } from '@prisma/client';

@Injectable()
export class PolicyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new policy version
   * Used by admin to publish updated policies
   */
  async createPolicyVersion(
    type: ConsentType,
    version: string,
    documentRef: string,
    publishedAt?: Date,
    requiresReacceptance: boolean = false,
  ) {
    // Check if version already exists for this type
    const existing = await this.prisma.policyVersion.findFirst({
      where: {
        type,
        version,
      },
    });

    if (existing) {
      throw new BadRequestException(`Policy version ${version} already exists for ${type}`);
    }

    const policyVersion = await this.prisma.policyVersion.create({
      data: {
        type,
        version,
        documentRef,
        publishedAt: publishedAt || new Date(),
        requiresReacceptance,
      },
    });

    return policyVersion;
  }

  /**
   * Get current (latest published) policy version for each type
   * Public endpoint - no authentication required
   */
  async getCurrentPolicies() {
    const now = new Date();

    // Get latest published version for each policy type
    const policies = await this.prisma.$queryRaw<any[]>`
      SELECT DISTINCT ON (type)
        id, type, version, document_ref, published_at, requires_reacceptance, created_at
      FROM policy_versions
      WHERE published_at <= ${now}
      ORDER BY type, published_at DESC, created_at DESC
    `;

    return policies.map((p) => ({
      id: p.id,
      type: p.type,
      version: p.version,
      documentRef: p.document_ref,
      publishedAt: p.published_at,
      requiresReacceptance: p.requires_reacceptance,
    }));
  }

  /**
   * Get a specific policy version
   * Public endpoint - no authentication required
   */
  async getPolicyVersion(id: string) {
    const policy = await this.prisma.policyVersion.findUnique({
      where: { id },
    });

    if (!policy) {
      throw new NotFoundException('Policy version not found');
    }

    // Only return published policies to public
    if (policy.publishedAt > new Date()) {
      throw new NotFoundException('Policy version not yet published');
    }

    return policy;
  }

  /**
   * Get all versions of a specific policy type
   * Public endpoint - no authentication required
   */
  async getPolicyVersionsByType(type: ConsentType) {
    const now = new Date();

    const policies = await this.prisma.policyVersion.findMany({
      where: {
        type,
        publishedAt: { lte: now },
      },
      orderBy: { publishedAt: 'desc' },
      select: {
        id: true,
        type: true,
        version: true,
        documentRef: true,
        publishedAt: true,
        requiresReacceptance: true,
        createdAt: true,
      },
    });

    return policies;
  }

  /**
   * Check if user needs to accept new policy versions
   * Returns policy types that require re-acceptance
   */
  async checkRequiredConsents(userId: string): Promise<ConsentType[]> {
    const currentPolicies = await this.getCurrentPolicies();
    const requiredTypes: ConsentType[] = [];

    for (const policy of currentPolicies) {
      // Find latest consent for this type
      const latestConsent = await this.prisma.consentRecord.findFirst({
        where: {
          userId,
          consentType: policy.type,
          withdrawnAt: null,
        },
        orderBy: { acceptedAt: 'desc' },
      });

      // If no consent or consent is for older version and new version requires reacceptance
      if (!latestConsent || (policy.requiresReacceptance && latestConsent.documentVersion !== policy.version)) {
        requiredTypes.push(policy.type);
      }
    }

    return requiredTypes;
  }
}

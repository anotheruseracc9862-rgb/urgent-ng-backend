import { Injectable } from '@nestjs/common';
import type { StartMode } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { sortForDisplay } from '../badges/badge.rules.js';

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
  bio: string | null;
  homeArea: string | null;
  deletionScheduledAt: Date | null;
  createdAt: Date;
}

export interface PublicProfileView {
  id: string;
  firstName: string;
  lastInitial: string;
  photoMediaId: string | null;
  bio: string | null;
  memberSince: Date;
  /** Earned badges, strongest first. Runner badges are hidden while the runner is not verified. */
  badges: string[];
  /** What other users may see of this user's record (Backend PRD 20.4). */
  stats: {
    completedAsRunner: number;
    completedAsRequester: number;
    runnerRating: { count: number; average: number | null };
    requesterRating: { count: number; average: number | null };
  };
}

/**
 * The signed-in user's own profile, and the small public view of another user.
 * Nothing sensitive (password hash, lockout state, deletion internals of others) is selected.
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
  ) {}

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
        profile: { select: { photoMediaId: true, bio: true, homeArea: true } },
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
      bio: user.profile?.bio ?? null,
      homeArea: user.profile?.homeArea ?? null,
      deletionScheduledAt: user.deletionScheduledAt,
      createdAt: user.createdAt,
    };
  }

  /**
   * `name` replaces first and last name together; `startMode` is a preference only (Backend PRD 9.1).
   * `bio` and `homeArea` live on the profile; `null` clears them.
   */
  async updateMe(
    userId: string,
    changes: { name?: string; startMode?: StartMode; bio?: string | null; homeArea?: string | null },
  ): Promise<MeView> {
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

    const profile: { bio?: string | null; homeArea?: string | null } = {};
    if (changes.bio !== undefined) {
      profile.bio = changes.bio === null ? null : changes.bio.trim() || null;
    }
    if (changes.homeArea !== undefined) {
      profile.homeArea = changes.homeArea === null ? null : changes.homeArea.trim() || null;
    }
    if (Object.keys(profile).length > 0) {
      await this.prisma.client.profile.upsert({
        where: { userId },
        create: { userId, ...profile },
        update: profile,
      });
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
        profile: { select: { photoMediaId: true, bio: true } },
      },
    });
    if (!user) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    const [stats, minCount, badgeRows] = await Promise.all([
      this.prisma.userStats.findUnique({ where: { userId } }),
      this.config.get('RATING_MIN_COUNT_FOR_AVERAGE'),
      this.prisma.$queryRaw<Array<{ badge: string }>>`
        SELECT b.badge::text AS badge FROM user_badges b
        WHERE b.user_id = ${userId}::uuid AND b.revoked_at IS NULL
          AND (
            b.badge IN ('NEW_REQUESTER'::"BadgeType", 'PROMPT_PAYER'::"BadgeType")
            OR EXISTS (
              SELECT 1 FROM verification_attempts v
              WHERE v.user_id = b.user_id AND v.status = 'VERIFIED'::"VerificationStatus" AND v.deleted_at IS NULL
                AND (v.expires_at IS NULL OR v.expires_at > now())
            )
          )
      `,
    ]);
    // A public average needs enough published ratings (Backend PRD 20.4); the count is always shown.
    const shown = (count: number, average: { toString(): string } | null | undefined) => ({
      count,
      average: average != null && count >= minCount ? Number(average.toString()) : null,
    });
    return {
      id: user.id,
      firstName: user.firstName,
      lastInitial: user.lastName.charAt(0).toUpperCase(),
      photoMediaId: user.profile?.photoMediaId ?? null,
      bio: user.profile?.bio ?? null,
      memberSince: user.createdAt,
      badges: sortForDisplay(badgeRows.map((r) => r.badge)),
      stats: {
        completedAsRunner: stats?.completedAsRunner ?? 0,
        completedAsRequester: stats?.completedAsRequester ?? 0,
        runnerRating: shown(stats?.runnerRatingCount ?? 0, stats?.runnerRatingAvg),
        requesterRating: shown(stats?.requesterRatingCount ?? 0, stats?.requesterRatingAvg),
      },
    };
  }
}

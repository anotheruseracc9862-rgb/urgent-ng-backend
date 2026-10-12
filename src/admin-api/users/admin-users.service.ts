import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service.js';
import { Paginated } from '../../common/pagination/paginated.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../../common/constants/error-codes.js';
import { maskIdentifier } from '../../auth/identifier.js';
import { AccountService, DELETION_BLOCKERS, type DeletionBlocker } from '../../auth/account.service.js';
import { SessionService } from '../../auth/session.service.js';
import { ConsentService } from '../../auth/consent.service.js';
import { VerificationStatusService } from '../../verification/verification-status.service.js';
import { ReliabilityService } from '../../reliability/reliability.service.js';
import { EnforcementService, toActionDto } from '../../enforcement/enforcement.service.js';
import { AdminPager, likePattern, phoneFragment } from '../common/admin-page.js';
import type { AdminUserContactDto, AdminUserDetailDto, AdminUserSummaryDto } from './admin-users.dto.js';

/** Users for the admin console (Backend PRD 24.4 area 1). Lists and detail mask contact data. */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pager: AdminPager,
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
    private readonly consents: ConsentService,
    private readonly verification: VerificationStatusService,
    private readonly reliability: ReliabilityService,
    private readonly enforcement: EnforcementService,
    @Inject(DELETION_BLOCKERS) private readonly blockers: DeletionBlocker[],
  ) {}

  async search(options: { q?: string; status?: UserStatus; cursor?: string; limit?: number }): Promise<Paginated<AdminUserSummaryDto>> {
    const limit = options.limit ?? 20;
    const after = this.pager.after(options.cursor);
    const conditions: Prisma.Sql[] = [Prisma.sql`u.deleted_at IS NULL`];
    if (options.status) {
      conditions.push(Prisma.sql`u.status = ${options.status}::"UserStatus"`);
    }
    const term = options.q?.trim();
    if (term) {
      const like = likePattern(term);
      const phone = phoneFragment(term);
      const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term);
      conditions.push(
        Prisma.sql`(u.name ILIKE ${like} OR u.email ILIKE ${like}
          ${phone ? Prisma.sql`OR u.phone_e164 LIKE ${`%${phone.replace(/^0/, '')}%`}` : Prisma.empty}
          ${isId ? Prisma.sql`OR u.id = ${term}::uuid` : Prisma.empty})`,
      );
    }
    if (after) {
      conditions.push(Prisma.sql`(u.created_at, u.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    }
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        status: UserStatus;
        phone_e164: string | null;
        email: string | null;
        created_at: Date;
        last_login_at: Date | null;
        verified: boolean;
        restrictions: number;
      }>
    >`
      SELECT u.id::text AS id, u.name, u.status, u.phone_e164, u.email, u.created_at, u.last_login_at,
             EXISTS (SELECT 1 FROM verification_attempts v WHERE v.user_id = u.id AND v.status = 'VERIFIED'::"VerificationStatus"
                       AND v.deleted_at IS NULL AND (v.expires_at IS NULL OR v.expires_at > now())) AS verified,
             (SELECT count(*)::int FROM user_restrictions r WHERE r.user_id = u.id AND r.status = 'ACTIVE'::"RestrictionStatus"
                       AND r.deleted_at IS NULL) AS restrictions
      FROM users u
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ${limit + 1}
    `;
    return this.pager.page(
      rows.map((r) => ({ ...r, createdAt: r.created_at })),
      limit,
      (r): AdminUserSummaryDto => ({
        id: r.id,
        name: r.name,
        status: r.status,
        phone: r.phone_e164 ? maskIdentifier(r.phone_e164) : null,
        email: r.email ? maskIdentifier(r.email) : null,
        verified: r.verified,
        activeRestrictions: r.restrictions,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
      }),
    );
  }

  async detail(userId: string): Promise<AdminUserDetailDto> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      include: { profile: true, stats: true },
    });
    if (!user) throw DomainException.of(RESOURCE_NOT_FOUND);

    const [latest, verified, explanation, restrictions, actions, badges, counts, blockers] = await Promise.all([
      this.verification.latest(userId),
      this.verification.isVerified(userId),
      this.reliability.explain(userId),
      this.prisma.userRestriction.findMany({ where: { userId, status: 'ACTIVE' }, orderBy: { startsAt: 'desc' } }),
      this.enforcement.listForUser(userId),
      this.prisma.userBadge.findMany({ where: { userId, revokedAt: null }, select: { badge: true } }),
      this.counts(userId),
      user.status === 'DELETION_PENDING' || user.deletionRequestedAt ? this.deletionBlockers(userId) : Promise.resolve([]),
    ]);

    return {
      id: user.id,
      name: user.name,
      status: user.status,
      phone: user.phoneE164 ? maskIdentifier(user.phoneE164) : null,
      email: user.email ? maskIdentifier(user.email) : null,
      verified,
      activeRestrictions: restrictions.length,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      bio: user.profile?.bio ?? null,
      homeArea: user.profile?.homeArea ?? null,
      startMode: user.startMode,
      photoMediaId: user.profile?.photoMediaId ?? null,
      stats: {
        completedAsRunner: user.stats?.completedAsRunner ?? 0,
        completedAsRequester: user.stats?.completedAsRequester ?? 0,
        runnerRatingCount: user.stats?.runnerRatingCount ?? 0,
        runnerRatingAvg: user.stats?.runnerRatingAvg ? Number(user.stats.runnerRatingAvg) : null,
        requesterRatingCount: user.stats?.requesterRatingCount ?? 0,
        requesterRatingAvg: user.stats?.requesterRatingAvg ? Number(user.stats.requesterRatingAvg) : null,
      },
      verification: {
        status: latest?.status ?? 'NOT_STARTED',
        failureReason: latest?.failureReason ?? null,
        attemptId: latest?.id ?? null,
        expiresAt: latest?.expiresAt ?? null,
        phoneVerified: user.phoneVerifiedAt !== null,
      },
      reliability: {
        points: explanation.points,
        reached: explanation.reached,
        windowDays: explanation.windowDays,
        thresholds: explanation.thresholds,
      },
      counts,
      deletion:
        user.deletionRequestedAt || user.deletionScheduledAt
          ? { requestedAt: user.deletionRequestedAt, scheduledAt: user.deletionScheduledAt, blockers }
          : null,
      restrictions: restrictions.map((r) => ({ id: r.id, type: r.type, startsAt: r.startsAt, endsAt: r.endsAt, enforcementActionId: r.enforcementActionId })),
      enforcement: actions as unknown as Array<Record<string, unknown>>,
      badges: badges.map((b) => b.badge),
    };
  }

  /** The full phone number and email. Needs SENSITIVE_DATA_VIEW and is audited by the controller. */
  async contact(userId: string): Promise<AdminUserContactDto> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { phoneE164: true, phoneVerifiedAt: true, email: true, emailVerifiedAt: true },
    });
    if (!user) throw DomainException.of(RESOURCE_NOT_FOUND);
    return {
      phone: user.phoneE164,
      email: user.email,
      phoneVerified: user.phoneVerifiedAt !== null,
      emailVerified: user.emailVerifiedAt !== null,
    };
  }

  consentHistory(userId: string) {
    return this.consents.history(userId);
  }

  async enforcementOf(userId: string) {
    await this.requireUser(userId);
    return this.enforcement.listForUser(userId);
  }

  /** Why the points are what they are: every event in the window that contributes. */
  async ladder(userId: string) {
    await this.requireUser(userId);
    return this.reliability.explain(userId);
  }

  async deactivate(userId: string, reason: string, ctx: { requestId?: string; ip?: string }) {
    await this.accounts.deactivate(userId, reason, ctx);
    return this.statusOf(userId);
  }

  async reactivate(userId: string, ctx: { requestId?: string; ip?: string }) {
    await this.accounts.reactivate(userId, ctx);
    return this.statusOf(userId);
  }

  async revokeSessions(userId: string): Promise<{ userId: string; revoked: boolean }> {
    await this.requireUser(userId);
    await this.sessions.revokeAllForUser(userId);
    return { userId, revoked: true };
  }

  async statusOf(userId: string): Promise<{ userId: string; status: UserStatus }> {
    const user = await this.prisma.user.findFirst({ where: { id: userId }, select: { status: true } });
    if (!user) throw DomainException.of(RESOURCE_NOT_FOUND);
    return { userId, status: user.status };
  }

  async requireUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({ where: { id: userId }, select: { id: true } });
    if (!user) throw DomainException.of(RESOURCE_NOT_FOUND);
  }

  // ---- internals ----

  private async counts(userId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, number>>>`
      SELECT
        (SELECT count(*)::int FROM errands WHERE requester_id = ${userId}::uuid AND deleted_at IS NULL AND status <> 'DRAFT'::"ErrandStatus") AS errands_posted,
        (SELECT count(*)::int FROM offers WHERE runner_id = ${userId}::uuid AND deleted_at IS NULL) AS offers_sent,
        (SELECT count(*)::int FROM assignments WHERE runner_id = ${userId}::uuid AND deleted_at IS NULL) AS assignments_as_runner,
        (SELECT count(*)::int FROM reports WHERE target_user_id = ${userId}::uuid AND deleted_at IS NULL) AS reports_against,
        (SELECT count(*)::int FROM risk_flags WHERE user_id = ${userId}::uuid AND status = 'OPEN'::"RiskFlagStatus") AS open_risk_flags,
        (SELECT count(*)::int FROM auth_sessions WHERE user_id = ${userId}::uuid AND revoked_at IS NULL AND expires_at > now()) AS active_sessions
    `;
    const r = rows[0];
    return {
      errandsPosted: r.errands_posted,
      offersSent: r.offers_sent,
      assignmentsAsRunner: r.assignments_as_runner,
      reportsAgainst: r.reports_against,
      openRiskFlags: r.open_risk_flags,
      activeSessions: r.active_sessions,
    };
  }

  private async deletionBlockers(userId: string) {
    const found = (await Promise.all(this.blockers.map((b) => b.check(userId)))).flat();
    return found.map((b) => ({ code: b.code, message: b.message }));
  }
}

export { toActionDto };

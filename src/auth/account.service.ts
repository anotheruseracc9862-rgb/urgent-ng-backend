import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  ACCOUNT_DEACTIVATED,
  ACCOUNT_DELETION_PENDING,
  DELETION_BLOCKED,
  RESOURCE_CONFLICT,
  RESOURCE_NOT_FOUND,
} from '../common/constants/error-codes.js';
import { AuthAuditService, type RequestContext } from './auth-audit.service.js';
import { randomBytes } from 'node:crypto';

/**
 * Something that stops an account from being deleted: an active errand or
 * assignment, an open report or dispute, an unsettled platform order (Backend PRD 9.5).
 * Each later module registers one under DELETION_BLOCKERS.
 */
export interface DeletionBlocker {
  /** Returns the reasons this user cannot be deleted yet (empty = none). */
  check(userId: string): Promise<Array<{ code: string; message: string }>>;
}

export const DELETION_BLOCKERS = Symbol('DELETION_BLOCKERS');

export interface AccountChange {
  status: 'ACTIVE' | 'DEACTIVATED' | 'DELETION_PENDING';
  deletionScheduledAt?: Date | null;
}

/**
 * Account lifecycle (Backend PRD 9.5). Every transition is one conditional UPDATE,
 * so two parallel requests cannot both succeed and no state is skipped.
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businessConfig: BusinessConfigService,
    private readonly audit: AuthAuditService,
    @Optional() @Inject(DELETION_BLOCKERS) private readonly blockers: DeletionBlocker[] = [],
  ) {}

  async deactivate(userId: string, reason: string | undefined, ctx: RequestContext): Promise<AccountChange> {
    const rows = await this.prisma.$queryRaw<Array<{ status: string }>>`
      UPDATE users SET status = 'DEACTIVATED'::"UserStatus", deactivated_at = now()
      WHERE id = ${userId}::uuid AND deleted_at IS NULL AND status = 'ACTIVE'::"UserStatus"
      RETURNING status::text AS status
    `;
    if (rows.length === 0) {
      await this.rejectTransition(userId);
    }
    await this.audit.record({
      action: 'account.deactivated',
      actorId: userId,
      metadata: { reason },
      ctx,
    });
    return { status: 'DEACTIVATED' };
  }

  async reactivate(userId: string, ctx: RequestContext): Promise<AccountChange> {
    const rows = await this.prisma.$queryRaw<Array<{ status: string }>>`
      UPDATE users SET status = 'ACTIVE'::"UserStatus", deactivated_at = NULL
      WHERE id = ${userId}::uuid AND deleted_at IS NULL AND status = 'DEACTIVATED'::"UserStatus"
      RETURNING status::text AS status
    `;
    if (rows.length === 0) {
      await this.rejectTransition(userId);
    }
    await this.audit.record({ action: 'account.reactivated', actorId: userId, ctx });
    return { status: 'ACTIVE' };
  }

  /**
   * Start the deletion grace period (ACCOUNT_DELETION_GRACE_DAYS, default 14). Refused with
   * DELETION_BLOCKED, listing the reasons, while anything still depends on the account.
   */
  async requestDeletion(userId: string, reason: string | undefined, ctx: RequestContext): Promise<AccountChange> {
    const reasons = (
      await Promise.all(this.blockers.map((blocker) => blocker.check(userId)))
    ).flat();
    if (reasons.length > 0) {
      throw DomainException.of(DELETION_BLOCKED, { details: { blockers: reasons } });
    }

    const graceDays = await this.businessConfig.get('ACCOUNT_DELETION_GRACE_DAYS');
    const rows = await this.prisma.$queryRaw<Array<{ scheduled: Date }>>`
      UPDATE users
      SET status = 'DELETION_PENDING'::"UserStatus",
          deletion_requested_at = now(),
          deletion_scheduled_at = now() + make_interval(days => ${graceDays}::int)
      WHERE id = ${userId}::uuid AND deleted_at IS NULL
        AND status IN ('ACTIVE'::"UserStatus", 'DEACTIVATED'::"UserStatus")
      RETURNING deletion_scheduled_at AS scheduled
    `;
    if (rows.length === 0) {
      await this.rejectTransition(userId);
    }
    await this.audit.record({
      action: 'account.deletion_requested',
      actorId: userId,
      metadata: { reason, graceDays },
      ctx,
    });
    return { status: 'DELETION_PENDING', deletionScheduledAt: rows[0].scheduled };
  }

  /** Cancel during the grace period. The account returns to what it was (ACTIVE or DEACTIVATED). */
  async cancelDeletion(userId: string, ctx: RequestContext): Promise<AccountChange> {
    const rows = await this.prisma.$queryRaw<Array<{ status: 'ACTIVE' | 'DEACTIVATED' }>>`
      UPDATE users
      SET status = CASE WHEN deactivated_at IS NOT NULL THEN 'DEACTIVATED'::"UserStatus" ELSE 'ACTIVE'::"UserStatus" END,
          deletion_requested_at = NULL, deletion_scheduled_at = NULL
      WHERE id = ${userId}::uuid AND deleted_at IS NULL AND status = 'DELETION_PENDING'::"UserStatus"
      RETURNING status::text AS status
    `;
    if (rows.length === 0) {
      await this.rejectTransition(userId);
    }
    await this.audit.record({ action: 'account.deletion_cancelled', actorId: userId, ctx });
    return { status: rows[0].status, deletionScheduledAt: null };
  }

  /**
   * Sweeper step 1: finish deletions whose grace period has ended. An account that has
   * picked up a blocker meanwhile (a new dispute, an unsettled order) stays pending and is
   * checked again tomorrow. Returns how many accounts were deleted.
   */
  async finalizeDueDeletions(limit = 100): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users
      WHERE status = 'DELETION_PENDING'::"UserStatus" AND deleted_at IS NULL AND deletion_scheduled_at <= now()
      ORDER BY deletion_scheduled_at LIMIT ${limit}
    `;

    let deleted = 0;
    for (const { id } of due) {
      const reasons = (await Promise.all(this.blockers.map((blocker) => blocker.check(id)))).flat();
      if (reasons.length > 0) {
        await this.prisma.$executeRaw`
          UPDATE users SET deletion_scheduled_at = now() + interval '1 day'
          WHERE id = ${id}::uuid AND status = 'DELETION_PENDING'::"UserStatus"
        `;
        continue;
      }

      const changed = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$executeRaw`
          UPDATE users SET status = 'DELETED'::"UserStatus", deleted_at = now()
          WHERE id = ${id}::uuid AND status = 'DELETION_PENDING'::"UserStatus" AND deleted_at IS NULL
            AND deletion_scheduled_at <= now()
        `;
        if (rows === 0) return false;
        await tx.$executeRaw`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = ${id}::uuid AND revoked_at IS NULL`;
        await tx.$executeRaw`UPDATE devices SET active = false, deleted_at = now() WHERE user_id = ${id}::uuid AND deleted_at IS NULL`;
        return true;
      });
      if (changed) {
        deleted += 1;
        await this.audit.record({ action: 'account.deleted', actorType: 'SYSTEM', entityType: 'user', entityId: id });
      }
    }
    return deleted;
  }

  /**
   * Sweeper step 2: scrub the personal data of accounts deleted more than ANONYMISATION_DAYS
   * ago. The row stays (marketplace records point at it as "Deleted User"). An account still
   * tied to an open report or dispute is left alone until the case closes. Returns the count.
   */
  async anonymiseDue(limit = 100): Promise<number> {
    const days = await this.businessConfig.get('ANONYMISATION_DAYS');
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users
      WHERE status = 'DELETED'::"UserStatus" AND anonymised_at IS NULL
        AND deleted_at <= now() - make_interval(days => ${days}::int)
      ORDER BY deleted_at LIMIT ${limit}
    `;

    let done = 0;
    for (const { id } of due) {
      const holds = (await Promise.all(this.blockers.map((blocker) => blocker.check(id)))).flat();
      if (holds.length > 0) continue;

      // The password hash is replaced with an unusable random value, never left readable.
      const unusable = `anonymised:${randomBytes(16).toString('hex')}`;
      const changed = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$executeRaw`
          UPDATE users SET
            name = 'Deleted User', first_name = 'Deleted', last_name = 'User',
            email = NULL, email_verified_at = NULL, phone_e164 = NULL, phone_verified_at = NULL,
            password_hash = ${unusable}, anonymised_at = now()
          WHERE id = ${id}::uuid AND status = 'DELETED'::"UserStatus" AND anonymised_at IS NULL
        `;
        if (rows === 0) return false;
        await tx.$executeRaw`UPDATE profiles SET photo_media_id = NULL, home_point = NULL, home_area = NULL WHERE user_id = ${id}::uuid`;
        await tx.$executeRaw`UPDATE consent_records SET ip_address = NULL, user_agent = NULL WHERE user_id = ${id}::uuid`;
        await tx.$executeRaw`UPDATE auth_sessions SET ip = NULL, user_agent = NULL WHERE user_id = ${id}::uuid`;
        return true;
      });
      if (changed) {
        done += 1;
        await this.audit.record({ action: 'account.anonymised', actorType: 'SYSTEM', entityType: 'user', entityId: id });
      }
    }
    return done;
  }

  /** The conditional UPDATE matched nothing: explain why. */
  private async rejectTransition(userId: string): Promise<never> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (!user) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (user.status === 'DEACTIVATED') {
      throw DomainException.of(ACCOUNT_DEACTIVATED);
    }
    if (user.status === 'DELETION_PENDING') {
      throw DomainException.of(ACCOUNT_DELETION_PENDING);
    }
    throw DomainException.of(RESOURCE_CONFLICT, {
      message: 'The account is not in a state that allows this change.',
      details: { status: user.status },
    });
  }
}

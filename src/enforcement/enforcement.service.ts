import { Injectable, Logger } from '@nestjs/common';
import {
  AuditActorType,
  type BadgeType,
  type EnforcementAction,
  type EnforcementActionType,
  type Prisma,
  type UserRestrictionType,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { BlocklistService } from '../auth/blocklist.service.js';
import { ErrandStateService } from '../errands/errand-state.service.js';
import { VerificationAdminService } from '../verification/verification-admin.service.js';
import { UserStatsService } from '../ratings/user-stats.service.js';
import { ReliabilityService } from '../reliability/reliability.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ERRAND_INVALID_STATE, RESOURCE_CONFLICT, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { LADDER_RESTRICTION_TYPES, ladderReason, levelsReached } from './enforcement.rules.js';
import type { AppealStateDto, EnforcementActionDto } from './enforcement.dto.js';

export interface ApplyActionInput {
  userId: string;
  type: EnforcementActionType;
  reason: string;
  /** Report, dispute or reliability event ids the action rests on. */
  caseRef?: string;
  /** Days the action lasts. Required for TEMPORARY_SUSPENSION and FEATURE_RESTRICTION; none for the rest. */
  durationDays?: number;
  /** FEATURE_RESTRICTION: which actions are paused (default OFFERING and POSTING). */
  restrictionTypes?: UserRestrictionType[];
  /** A safety-critical suspension stops execution at once. Defaults to true for a permanent one. */
  safetyCritical?: boolean;
  /** BADGE_REMOVAL: the badge taken away. */
  badge?: BadgeType;
  /** CONTENT_REMOVAL: what is removed. */
  content?: { type: 'RATING' | 'MESSAGE' | 'ERRAND'; id: string };
  /** Reliability events the action rests on (linked as its causes). */
  causeEventIds?: string[];
}

export interface AdminContext {
  adminId: string;
  /** Set when the action is the answer to a review case. */
  reviewId?: string;
}

interface CreateContext {
  trigger: 'LADDER' | 'SEVERE_EVENT' | 'ADMIN';
  ladderLevel?: 'WARNING' | 'RESTRICTION' | 'SUSPENSION';
  actor: { type: AuditActorType; id?: string };
}

export function toActionDto(row: EnforcementAction): EnforcementActionDto {
  const appeal: AppealStateDto = {
    requestedAt: row.appealRequestedAt,
    dueAt: row.appealDueAt,
    outcome: row.appealOutcome,
    decidedAt: row.appealDecidedAt,
  };
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    reason: row.reason,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    canAppeal: row.status !== 'REVOKED' && row.appealRequestedAt === null && row.type !== 'WARNING',
    appeal,
  };
}

/**
 * Enforcement (Backend PRD 21.4, 21.7). Progressive: a warning, then a short restriction, then a
 * suspension, then an admin decision; never a ban from one incident. Every action is a row with
 * its reason, trigger, actor, window and the events it rests on; there is no change of a user's
 * status without one.
 *
 * Positive events do not erase points, so the ladder looks only at the rolling-window total. Each
 * level is applied at most once per window per user (a revoked action still counts, so an appeal
 * that succeeds is not undone by the next event).
 */
@Injectable()
export class EnforcementService {
  private readonly logger = new Logger(EnforcementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: BusinessConfigService,
    private readonly reliability: ReliabilityService,
    private readonly blocklist: BlocklistService,
    private readonly errandState: ErrandStateService,
    private readonly stats: UserStatsService,
    private readonly verification: VerificationAdminService,
  ) {}

  // ---- The ladder ----

  /**
   * Apply what the user's points call for. Safe to call as often as events arrive: it takes a
   * per-user lock and writes nothing that already exists in the window.
   */
  async evaluate(userId: string): Promise<{ applied: EnforcementActionType[]; reviewOpened: boolean }> {
    const [warning, restriction, suspension, adminReview, windowDays, restrictionDays, suspensionDays] = await Promise.all([
      this.config.get('LADDER_WARNING_POINTS'),
      this.config.get('LADDER_RESTRICTION_POINTS'),
      this.config.get('LADDER_SUSPENSION_POINTS'),
      this.config.get('LADDER_ADMIN_REVIEW_POINTS'),
      this.config.get('RELIABILITY_WINDOW_DAYS'),
      this.config.get('LADDER_RESTRICTION_DAYS'),
      this.config.get('LADDER_SUSPENSION_DAYS'),
    ]);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`enforcement:${userId}`}))`;
      const points = await this.reliability.windowPoints(tx, userId);
      const levels = levelsReached(points, { warning, restriction, suspension, adminReview });
      const applied: EnforcementActionType[] = [];
      let reviewOpened = false;
      if (levels.length === 0) return { applied, reviewOpened };

      const causes = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM reliability_events
        WHERE user_id = ${userId}::uuid AND severity > 0
          AND occurred_at > clock_timestamp() - make_interval(days => ${windowDays}::int)
        ORDER BY occurred_at
      `;
      const causeEventIds = causes.map((c) => c.id);

      for (const level of levels) {
        if (level === 'ADMIN_REVIEW') {
          reviewOpened = await this.openReview(tx, userId, {
            trigger: 'LADDER_ADMIN_REVIEW',
            reason: `Reliability points reached ${points} in the last ${windowDays} days.`,
            points,
          });
          continue;
        }
        // Each level once per window, whatever became of the earlier action (a revoked one counts).
        const existing = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text FROM enforcement_actions
          WHERE user_id = ${userId}::uuid AND ladder_level = ${level}
            AND created_at > clock_timestamp() - make_interval(days => ${windowDays}::int)
          LIMIT 1
        `;
        if (existing.length > 0) continue;

        const input: ApplyActionInput =
          level === 'WARNING'
            ? { userId, type: 'WARNING', reason: ladderReason('WARNING', points, windowDays), causeEventIds }
            : level === 'RESTRICTION'
              ? {
                  userId,
                  type: 'FEATURE_RESTRICTION',
                  reason: ladderReason('RESTRICTION', points, windowDays),
                  durationDays: restrictionDays,
                  restrictionTypes: [...LADDER_RESTRICTION_TYPES],
                  causeEventIds,
                }
              : {
                  userId,
                  type: 'TEMPORARY_SUSPENSION',
                  reason: ladderReason('SUSPENSION', points, windowDays),
                  durationDays: suspensionDays,
                  // A ladder suspension lets the user finish their errands (Backend PRD 21.4).
                  safetyCritical: false,
                  causeEventIds,
                };
        const action = await this.create(tx, input, { trigger: 'LADDER', ladderLevel: level, actor: { type: AuditActorType.SYSTEM } });
        applied.push(action.type);
      }
      return { applied, reviewOpened };
    });
  }

  // ---- Admin ----

  /**
   * An admin applies an action (the controller and four-eyes wrapper arrive with P11). Answers a
   * review case when `reviewId` is given. A verification revocation goes through the verification
   * service first; a user with nothing to revoke still gets the action recorded.
   */
  async adminApply(input: ApplyActionInput, admin: AdminContext): Promise<EnforcementAction> {
    this.assertShape(input);
    if (input.type === 'VERIFICATION_REVOCATION') {
      try {
        await this.verification.revoke(input.userId, { adminId: admin.adminId }, input.reason);
      } catch (error) {
        if (!(error instanceof DomainException) || error.getCode() !== RESOURCE_CONFLICT) throw error;
      }
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`enforcement:${input.userId}`}))`;
      const action = await this.create(tx, input, {
        trigger: admin.reviewId ? 'SEVERE_EVENT' : 'ADMIN',
        actor: { type: AuditActorType.ADMIN, id: admin.adminId },
      });
      if (admin.reviewId) {
        await this.closeReview(tx, admin.reviewId, admin.adminId, 'ACTIONED', input.reason, action.id);
      }
      return action;
    });
  }

  /** An admin ends an action early (a mistake, an appeal, a change of circumstances). */
  async adminRevoke(actionId: string, reason: string, admin: { adminId: string }): Promise<EnforcementAction> {
    return this.prisma.$transaction(async (tx) => {
      const action = await this.lockAction(tx, actionId);
      if (action.status !== 'ACTIVE') {
        throw DomainException.of(ERRAND_INVALID_STATE, { message: 'This action is no longer active.', details: { status: action.status } });
      }
      return this.end(tx, action, 'REVOKED', reason, { type: AuditActorType.ADMIN, id: admin.adminId });
    });
  }

  /** Close a review case with no action. */
  async dismissReview(reviewId: string, note: string, admin: { adminId: string }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.closeReview(tx, reviewId, admin.adminId, 'DISMISSED', note, null);
    });
  }

  /**
   * Put a user in front of an admin without applying anything: confirmed fraud, a safety
   * incident or a prohibited item skip the ladder (Backend PRD 21.1). One open review per user.
   */
  async flagSevere(tx: Prisma.TransactionClient, userId: string, details: { reason: string; caseRef?: string }): Promise<boolean> {
    return this.openReview(tx, userId, { trigger: 'SEVERE_EVENT', reason: details.reason, caseRef: details.caseRef });
  }

  // ---- The user ----

  async listForUser(userId: string): Promise<EnforcementActionDto[]> {
    const rows = await this.prisma.enforcementAction.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.map(toActionDto);
  }

  /** The user asks for a decision to be reconsidered, once per action. An admin decides. */
  async requestAppeal(userId: string, actionId: string, note: string): Promise<EnforcementActionDto> {
    const days = await this.config.get('APPEAL_RESPONSE_DAYS');
    const text = note.trim();
    if (!text) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'Say why you are appealing.', details: { field: 'note' } });
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM enforcement_actions WHERE id = ${actionId}::uuid AND user_id = ${userId}::uuid FOR UPDATE
      `;
      if (!locked[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
      const action = await tx.enforcementAction.findUniqueOrThrow({ where: { id: actionId } });
      if (action.status === 'REVOKED' || action.type === 'WARNING') {
        throw DomainException.of(ERRAND_INVALID_STATE, { message: 'This action cannot be appealed.', details: { reason: 'NOT_APPEALABLE' } });
      }
      if (action.appealRequestedAt) {
        throw DomainException.of(RESOURCE_CONFLICT, { message: 'You already appealed this action.', details: { reason: 'ALREADY_APPEALED' } });
      }
      const due = await tx.$queryRaw<Array<{ due: Date }>>`SELECT clock_timestamp() + make_interval(days => ${days}::int) AS due`;
      const updated = await tx.enforcementAction.update({
        where: { id: actionId },
        data: { appealRequestedAt: new Date(), appealNote: text, appealDueAt: due[0].due },
      });
      await this.outbox.add(tx, {
        eventType: 'enforcement.appeal_requested',
        aggregateType: 'user',
        aggregateId: userId,
        payload: { actionId, userId, type: action.type },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'enforcement.appeal_requested',
        entityType: 'enforcement_action',
        entityId: actionId,
      });
      return updated;
    });
    return toActionDto(row);
  }

  /** An admin answers an appeal. REVOKED lifts the action; UPHELD leaves it. */
  async adminDecideAppeal(
    actionId: string,
    outcome: 'UPHELD' | 'REVOKED',
    note: string,
    admin: { adminId: string },
  ): Promise<EnforcementAction> {
    return this.prisma.$transaction(async (tx) => {
      const action = await this.lockAction(tx, actionId);
      if (!action.appealRequestedAt || action.appealOutcome) {
        throw DomainException.of(ERRAND_INVALID_STATE, { message: 'There is no open appeal on this action.', details: { reason: 'NO_OPEN_APPEAL' } });
      }
      await tx.enforcementAction.update({
        where: { id: actionId },
        data: { appealOutcome: outcome, appealDecidedBy: admin.adminId, appealDecidedAt: new Date() },
      });
      let result = await tx.enforcementAction.findUniqueOrThrow({ where: { id: actionId } });
      if (outcome === 'REVOKED' && result.status === 'ACTIVE') {
        result = await this.end(tx, result, 'REVOKED', `Appeal succeeded: ${note}`, { type: AuditActorType.ADMIN, id: admin.adminId });
      }
      await this.outbox.add(tx, {
        eventType: 'enforcement.appeal_decided',
        aggregateType: 'user',
        aggregateId: action.userId,
        payload: { actionId, userId: action.userId, outcome, type: action.type },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: admin.adminId,
        action: 'enforcement.appeal_decided',
        entityType: 'enforcement_action',
        entityId: actionId,
        reasonCode: outcome,
        metadata: { userId: action.userId },
      });
      return result;
    });
  }

  // ---- Expiry (scheduler) ----

  /** End actions whose window passed: restrictions expire, a suspension lifts. Idempotent. */
  async expireDue(batch = 100): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM enforcement_actions
        WHERE status = 'ACTIVE'::"RestrictionStatus" AND ends_at IS NOT NULL AND ends_at <= clock_timestamp()
        ORDER BY ends_at
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED
      `;
      for (const { id } of due) {
        const action = await tx.enforcementAction.findUniqueOrThrow({ where: { id } });
        await this.end(tx, action, 'EXPIRED', 'The period ended.', { type: AuditActorType.SYSTEM });
      }
      return due.length;
    });
  }

  // ---- Internals ----

  private assertShape(input: ApplyActionInput): void {
    const bad = (message: string, field: string) => DomainException.of(VALIDATION_ERROR, { message, details: { field } });
    if (!input.reason.trim()) throw bad('An action needs a reason.', 'reason');
    if ((input.type === 'TEMPORARY_SUSPENSION' || input.type === 'FEATURE_RESTRICTION') && !(input.durationDays && input.durationDays > 0)) {
      throw bad('This action needs a duration in days.', 'durationDays');
    }
    if (input.type === 'BADGE_REMOVAL' && !input.badge) throw bad('A badge removal needs the badge.', 'badge');
    if (input.type === 'CONTENT_REMOVAL' && !input.content) throw bad('A content removal needs its target.', 'content');
    if (input.type === 'FEATURE_RESTRICTION' && input.restrictionTypes && input.restrictionTypes.length === 0) {
      throw bad('Choose what is restricted.', 'restrictionTypes');
    }
  }

  /** Write the action, apply its effects, link its causes, raise the event. Inside the caller's transaction. */
  private async create(tx: Prisma.TransactionClient, input: ApplyActionInput, context: CreateContext): Promise<EnforcementAction> {
    const permanent = input.type === 'PERMANENT_SUSPENSION';
    const suspension = permanent || input.type === 'TEMPORARY_SUSPENSION';
    const restricting = input.type === 'FEATURE_RESTRICTION';
    const timed = suspension || restricting ? !permanent && input.durationDays !== undefined : false;
    const safetyCritical = suspension ? (input.safetyCritical ?? permanent) : false;

    const user = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status::text AS status FROM users WHERE id = ${input.userId}::uuid FOR UPDATE
    `;
    if (!user[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
    const statusBefore = suspension && (user[0].status === 'ACTIVE' || user[0].status === 'DEACTIVATED') ? user[0].status : null;

    const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const now = nowRows[0].now;
    const endsAt = timed ? new Date(now.getTime() + (input.durationDays as number) * 86_400_000) : null;

    const action = await tx.enforcementAction.create({
      data: {
        userId: input.userId,
        type: input.type,
        reason: input.reason.trim(),
        trigger: context.trigger,
        ladderLevel: context.ladderLevel ?? null,
        caseRef: input.caseRef ?? null,
        actorType: context.actor.type,
        actorId: context.actor.id ?? null,
        startsAt: now,
        endsAt,
        safetyCritical,
        targetBadge: input.badge ?? null,
        targetType: input.content?.type ?? null,
        targetId: input.content?.id ?? null,
        userStatusBefore: statusBefore as 'ACTIVE' | 'DEACTIVATED' | null,
      },
    });

    if (input.causeEventIds && input.causeEventIds.length > 0) {
      for (const reliabilityEventId of input.causeEventIds) {
        await tx.enforcementActionEvent.create({ data: { enforcementActionId: action.id, reliabilityEventId } });
      }
    }

    if (restricting) {
      const types = input.restrictionTypes ?? [...LADDER_RESTRICTION_TYPES];
      for (const type of types) {
        await tx.userRestriction.create({
          data: { userId: input.userId, type, status: 'ACTIVE', startsAt: now, endsAt, enforcementActionId: action.id },
        });
      }
    }
    if (suspension) {
      await tx.$executeRaw`
        UPDATE users SET status = 'SUSPENDED'::"UserStatus", updated_at = clock_timestamp()
        WHERE id = ${input.userId}::uuid AND status IN ('ACTIVE'::"UserStatus", 'DEACTIVATED'::"UserStatus")
      `;
    }
    if (permanent) {
      await this.blockIdentifiers(tx, input.userId, action.id, input.reason);
    }
    if (input.type === 'CONTENT_REMOVAL' && input.content) {
      await this.removeContent(tx, input.content, context.actor, input.reason);
    }

    await this.outbox.add(tx, {
      eventType: 'enforcement.applied',
      aggregateType: 'user',
      aggregateId: input.userId,
      payload: {
        actionId: action.id,
        userId: input.userId,
        type: input.type,
        trigger: context.trigger,
        ladderLevel: context.ladderLevel ?? null,
        endsAt,
        safetyCritical,
        badge: input.badge ?? null,
      },
    });
    await this.audit.recordInTransaction(tx, {
      actorType: context.actor.type,
      actorId: context.actor.id,
      action: 'enforcement.applied',
      entityType: 'enforcement_action',
      entityId: action.id,
      reasonCode: context.trigger,
      metadata: { userId: input.userId, type: input.type, ladderLevel: context.ladderLevel ?? null, endsAt, caseRef: input.caseRef ?? null },
    });
    return action;
  }

  /** Revoke or expire an action: its restrictions end, a suspension lifts if it was the last one. */
  private async end(
    tx: Prisma.TransactionClient,
    action: EnforcementAction,
    status: 'EXPIRED' | 'REVOKED',
    reason: string,
    actor: { type: AuditActorType; id?: string },
  ): Promise<EnforcementAction> {
    const updated = await tx.enforcementAction.update({
      where: { id: action.id },
      data: { status, endedReason: reason },
    });
    await tx.$executeRaw`
      UPDATE user_restrictions SET status = ${status}::"RestrictionStatus", updated_at = clock_timestamp()
      WHERE enforcement_action_id = ${action.id}::uuid AND status = 'ACTIVE'::"RestrictionStatus"
    `;

    let restored = false;
    if (action.type === 'TEMPORARY_SUSPENSION' || action.type === 'PERMANENT_SUSPENSION') {
      const others = await tx.enforcementAction.count({
        where: {
          userId: action.userId,
          id: { not: action.id },
          status: 'ACTIVE',
          type: { in: ['TEMPORARY_SUSPENSION', 'PERMANENT_SUSPENSION'] },
        },
      });
      if (others === 0) {
        const target = action.userStatusBefore === 'DEACTIVATED' ? 'DEACTIVATED' : 'ACTIVE';
        const changed = await tx.$executeRaw`
          UPDATE users SET status = ${target}::"UserStatus", updated_at = clock_timestamp()
          WHERE id = ${action.userId}::uuid AND status = 'SUSPENDED'::"UserStatus"
        `;
        restored = changed > 0;
      }
    }

    await this.outbox.add(tx, {
      eventType: status === 'EXPIRED' ? 'enforcement.expired' : 'enforcement.revoked',
      aggregateType: 'user',
      aggregateId: action.userId,
      payload: { actionId: action.id, userId: action.userId, type: action.type, restored, badge: action.targetBadge },
    });
    await this.audit.recordInTransaction(tx, {
      actorType: actor.type,
      actorId: actor.id,
      action: status === 'EXPIRED' ? 'enforcement.expired' : 'enforcement.revoked',
      entityType: 'enforcement_action',
      entityId: action.id,
      metadata: { userId: action.userId, type: action.type, restored },
    });
    return updated;
  }

  private async lockAction(tx: Prisma.TransactionClient, actionId: string): Promise<EnforcementAction> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM enforcement_actions WHERE id = ${actionId}::uuid FOR UPDATE
    `;
    if (!locked[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
    return tx.enforcementAction.findUniqueOrThrow({ where: { id: actionId } });
  }

  /** Returns whether a review was newly opened (an open one for the same trigger is kept). */
  private async openReview(
    tx: Prisma.TransactionClient,
    userId: string,
    input: { trigger: 'LADDER_ADMIN_REVIEW' | 'SEVERE_EVENT'; reason: string; caseRef?: string; points?: number },
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO enforcement_reviews (user_id, "trigger", reason, case_ref, points, updated_at)
      VALUES (${userId}::uuid, ${input.trigger}, ${input.reason}, ${input.caseRef ?? null}, ${input.points ?? null}, clock_timestamp())
      ON CONFLICT (user_id, "trigger") WHERE status = 'OPEN' AND deleted_at IS NULL DO NOTHING
      RETURNING id::text
    `;
    const id = rows[0]?.id;
    if (!id) return false;
    await this.outbox.add(tx, {
      eventType: 'enforcement.review_needed',
      aggregateType: 'user',
      aggregateId: userId,
      payload: { reviewId: id, userId, trigger: input.trigger, points: input.points ?? null },
    });
    return true;
  }

  private async closeReview(
    tx: Prisma.TransactionClient,
    reviewId: string,
    adminId: string,
    status: 'ACTIONED' | 'DISMISSED',
    note: string,
    resultingActionId: string | null,
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE enforcement_reviews
      SET status = ${status}, decided_by = ${adminId}::uuid, decided_at = clock_timestamp(), decision_note = ${note},
          resulting_action_id = ${resultingActionId}::uuid, updated_at = clock_timestamp()
      WHERE id = ${reviewId}::uuid AND status = 'OPEN' AND deleted_at IS NULL
    `;
    if (changed === 0) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'There is no open review with that id.' });
    }
    await this.audit.recordInTransaction(tx, {
      actorType: AuditActorType.ADMIN,
      actorId: adminId,
      action: `enforcement.review_${status.toLowerCase()}`,
      entityType: 'enforcement_review',
      entityId: reviewId,
      metadata: { resultingActionId },
    });
  }

  /** A permanent suspension blocks the phone, email and verified identity (Backend PRD 21.7). */
  private async blockIdentifiers(tx: Prisma.TransactionClient, userId: string, actionId: string, reason: string): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { phoneE164: true, email: true } });
    const identity = await tx.verificationAttempt.findFirst({
      where: { userId, identityRefHmac: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { identityRefHmac: true },
    });
    await this.blocklist.blockAccountInTransaction(
      tx,
      { phoneE164: user?.phoneE164, email: user?.email, identityHash: identity?.identityRefHmac },
      reason,
      actionId,
    );
  }

  /** Remove the content an action targets: through the services that own it, never by hand. */
  private async removeContent(
    tx: Prisma.TransactionClient,
    content: { type: 'RATING' | 'MESSAGE' | 'ERRAND'; id: string },
    actor: { type: AuditActorType; id?: string },
    reason: string,
  ): Promise<void> {
    if (content.type === 'RATING') {
      const rows = await tx.$queryRaw<Array<{ ratee_id: string }>>`
        UPDATE ratings SET status = 'REMOVED'::"RatingStatus", updated_at = clock_timestamp()
        WHERE id = ${content.id}::uuid AND deleted_at IS NULL
        RETURNING ratee_id::text
      `;
      if (!rows[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
      await this.stats.recompute(tx, rows[0].ratee_id);
      return;
    }
    if (content.type === 'MESSAGE') {
      const changed = await tx.$executeRaw`
        UPDATE messages
        SET status = 'REMOVED'::"MessageStatus", removed_at = clock_timestamp(), removal_reason = 'ENFORCEMENT'
        WHERE id = ${content.id}::uuid AND deleted_at IS NULL AND status <> 'REMOVED'::"MessageStatus"
      `;
      if (changed === 0) throw DomainException.of(RESOURCE_NOT_FOUND);
      return;
    }
    // An errand is taken down through the state machine, so offers and assignments follow.
    await this.errandState.transition(tx, {
      errandId: content.id,
      to: 'CANCELLED',
      expectedFrom: ['OPEN', 'RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS'],
      actor: { type: 'ADMIN', id: actor.id },
      cancellation: { reason: 'ADMIN_CANCELLED', note: reason },
      reason: 'Removed by enforcement.',
    });
    this.logger.log(`Errand ${content.id} removed by enforcement`);
  }
}

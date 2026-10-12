import { Injectable } from '@nestjs/common';
import { AuditActorType, Prisma, RatingDimension, type Rating, type RatingScore } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RATING_ALREADY_SUBMITTED, RATING_NOT_ELIGIBLE, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { UserStatsService } from './user-stats.service.js';
import type {
  AssignmentRatingsDto,
  EditRatingDto,
  MyRatingDto,
  MyRatingsQueryDto,
  ProfileRatingDto,
  RatingDto,
  RatingListQueryDto,
  RatingScoresDto,
  RatingScoresViewDto,
  SubmitRatingDto,
} from './ratings.dto.js';

type Direction = 'REQUESTER_TO_RUNNER' | 'RUNNER_TO_REQUESTER';
type RatingWithScores = Rating & { scores: RatingScore[] };

const DIMENSION_FIELDS: Array<[keyof RatingScoresDto, RatingDimension]> = [
  ['overall', RatingDimension.OVERALL],
  ['reliability', RatingDimension.RELIABILITY],
  ['communication', RatingDimension.COMMUNICATION],
  ['timeliness', RatingDimension.TIMELINESS],
  ['paymentConduct', RatingDimension.PAYMENT_CONDUCT],
];

const DAY_MS = 86_400_000;

export function toScoresView(scores: Array<{ dimension: RatingDimension; score: number }>): RatingScoresViewDto {
  const by = new Map(scores.map((s) => [s.dimension, s.score]));
  return {
    overall: by.get(RatingDimension.OVERALL) ?? null,
    reliability: by.get(RatingDimension.RELIABILITY) ?? null,
    communication: by.get(RatingDimension.COMMUNICATION) ?? null,
    timeliness: by.get(RatingDimension.TIMELINESS) ?? null,
    paymentConduct: by.get(RatingDimension.PAYMENT_CONDUCT) ?? null,
  };
}

/** The rating as its rater sees it, or as the ratee sees it once revealed. */
export function toRatingDto(row: RatingWithScores, now: Date): RatingDto {
  const editable = row.revealedAt === null && row.status === 'PUBLISHED' && row.editableUntil.getTime() > now.getTime();
  return {
    id: row.id,
    assignmentId: row.assignmentId,
    direction: row.direction,
    scores: toScoresView(row.scores),
    review: row.review,
    status: row.status,
    revealed: row.revealedAt !== null,
    editable,
    editableUntil: editable ? row.editableUntil : null,
    createdAt: row.createdAt,
  };
}

interface AssignmentRow {
  id: string;
  errand_id: string;
  requester_id: string;
  runner_id: string;
  status: string;
  completed_at: Date | null;
  db_now: Date;
}

/**
 * Ratings (Backend PRD 20). Only the two parties of a COMPLETED assignment rate each other, once
 * per direction, inside the rating window.
 *
 * Blind reveal: a rating is invisible to its ratee and counts in no aggregate until both sides
 * have rated or the window closes (`revealed_at`). The assignment row is locked for every submit,
 * so two parties submitting at the same moment still see each other and the reveal happens exactly
 * once. A rating is editable until it is revealed or `RATING_EDIT_HOURS` after it was submitted,
 * whichever is first; every edit keeps the previous content.
 */
@Injectable()
export class RatingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: BusinessConfigService,
    private readonly stats: UserStatsService,
    private readonly cursors: CursorService,
  ) {}

  // ---- Submit ----

  async submit(userId: string, assignmentId: string, input: SubmitRatingDto): Promise<RatingDto> {
    const scores = this.toScoreRows(input.scores, true);
    const review = this.cleanReview(input.review);
    // Config reads need a pool connection: do them before the transaction.
    const [windowDays, editHours] = await Promise.all([this.config.get('RATING_WINDOW_DAYS'), this.config.get('RATING_EDIT_HOURS')]);

    const created = await this.prisma.$transaction(async (tx) => {
      const assignment = await this.lockParty(tx, userId, assignmentId);
      if (assignment.status !== 'COMPLETED' || !assignment.completed_at) {
        throw DomainException.of(RATING_NOT_ELIGIBLE, {
          message: 'You can rate once the errand is completed.',
          details: { reason: 'NOT_COMPLETED' },
        });
      }
      const windowEnd = new Date(assignment.completed_at.getTime() + windowDays * DAY_MS);
      if (assignment.db_now.getTime() >= windowEnd.getTime()) {
        throw DomainException.of(RATING_NOT_ELIGIBLE, {
          message: 'The rating window for this errand has closed.',
          details: { reason: 'WINDOW_CLOSED' },
        });
      }

      const isRequester = assignment.requester_id === userId;
      const direction: Direction = isRequester ? 'REQUESTER_TO_RUNNER' : 'RUNNER_TO_REQUESTER';
      const other: Direction = isRequester ? 'RUNNER_TO_REQUESTER' : 'REQUESTER_TO_RUNNER';
      const rateeId = isRequester ? assignment.runner_id : assignment.requester_id;

      const existing = await tx.rating.findFirst({ where: { assignmentId, direction, deletedAt: null }, select: { id: true } });
      if (existing) {
        throw DomainException.of(RATING_ALREADY_SUBMITTED);
      }
      const counterpart = await tx.rating.findFirst({ where: { assignmentId, direction: other, deletedAt: null } });

      const editableUntil = new Date(Math.min(assignment.db_now.getTime() + editHours * 3_600_000, windowEnd.getTime()));
      const row = await tx.rating.create({
        data: {
          assignmentId,
          raterId: userId,
          rateeId,
          direction,
          review,
          editableUntil,
          scores: { create: scores.map(({ dimension, score }) => ({ dimension, score })) },
        },
        include: { scores: true },
      });

      await this.outbox.add(tx, {
        eventType: 'rating.submitted',
        aggregateType: 'rating',
        aggregateId: row.id,
        payload: { ratingId: row.id, assignmentId, errandId: assignment.errand_id, raterId: userId, rateeId, direction },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'rating.submitted',
        entityType: 'rating',
        entityId: row.id,
        metadata: { assignmentId, direction, dimensions: scores.map((s) => s.dimension), hasReview: review !== null },
      });

      // Both sides are in: reveal both now (Backend PRD 20.3).
      let revealed = row;
      if (counterpart && counterpart.revealedAt === null) {
        await this.reveal(tx, [{ ...row, errandId: assignment.errand_id }, { ...counterpart, errandId: assignment.errand_id }], 'BOTH_SUBMITTED', assignment.db_now);
        revealed = await tx.rating.findUniqueOrThrow({ where: { id: row.id }, include: { scores: true } });
      }
      return { row: revealed, now: assignment.db_now };
    });
    return toRatingDto(created.row, created.now);
  }

  // ---- Edit ----

  async edit(userId: string, ratingId: string, input: EditRatingDto): Promise<RatingDto> {
    if (input.scores === undefined && input.review === undefined) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'Send scores or a review to change.', details: { field: 'scores' } });
    }
    const scores = input.scores ? this.toScoreRows(input.scores, false) : [];
    if (input.scores && scores.length === 0) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'Send at least one score to change.', details: { field: 'scores' } });
    }
    const review = input.review === undefined ? undefined : this.cleanReview(input.review);

    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; status: string; revealed_at: Date | null; editable_until: Date; db_now: Date }>>`
        SELECT id::text, status::text AS status, revealed_at, editable_until, clock_timestamp() AS db_now
        FROM ratings
        WHERE id = ${ratingId}::uuid AND rater_id = ${userId}::uuid AND deleted_at IS NULL
        FOR UPDATE
      `;
      const current = locked[0];
      if (!current) {
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }
      if (current.status !== 'PUBLISHED') {
        throw DomainException.of(RATING_NOT_ELIGIBLE, { message: 'This rating can no longer be changed.', details: { reason: 'MODERATED' } });
      }
      if (current.revealed_at !== null) {
        throw DomainException.of(RATING_NOT_ELIGIBLE, { message: 'This rating was revealed and can no longer be changed.', details: { reason: 'REVEALED' } });
      }
      if (current.db_now.getTime() >= current.editable_until.getTime()) {
        throw DomainException.of(RATING_NOT_ELIGIBLE, { message: 'The time to change this rating has passed.', details: { reason: 'EDIT_WINDOW_CLOSED' } });
      }

      const before = await tx.rating.findUniqueOrThrow({ where: { id: ratingId }, include: { scores: true } });
      await tx.ratingEdit.create({
        data: {
          ratingId,
          previous: { scores: toScoresView(before.scores), review: before.review } as unknown as Prisma.InputJsonValue,
        },
      });
      for (const { dimension, score } of scores) {
        await tx.ratingScore.upsert({
          where: { ratingId_dimension: { ratingId, dimension } },
          create: { ratingId, dimension, score },
          update: { score },
        });
      }
      if (review !== undefined) {
        await tx.rating.update({ where: { id: ratingId }, data: { review } });
      } else {
        await tx.rating.update({ where: { id: ratingId }, data: { updatedAt: current.db_now } });
      }
      await this.outbox.add(tx, {
        eventType: 'rating.updated',
        aggregateType: 'rating',
        aggregateId: ratingId,
        payload: { ratingId, assignmentId: before.assignmentId, raterId: userId, rateeId: before.rateeId },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'rating.edited',
        entityType: 'rating',
        entityId: ratingId,
        metadata: { assignmentId: before.assignmentId, dimensions: scores.map((s) => s.dimension), reviewChanged: review !== undefined },
      });
      const after = await tx.rating.findUniqueOrThrow({ where: { id: ratingId }, include: { scores: true } });
      return { row: after, now: current.db_now };
    });
    return toRatingDto(result.row, result.now);
  }

  // ---- Reads ----

  /** What the caller can do about this assignment's ratings, and what they may see of them. */
  async forAssignment(userId: string, assignmentId: string): Promise<AssignmentRatingsDto> {
    const windowDays = await this.config.get('RATING_WINDOW_DAYS');
    const rows = await this.prisma.$queryRaw<AssignmentRow[]>`
      SELECT id::text, errand_id::text, requester_id::text, runner_id::text, status::text AS status, completed_at,
             clock_timestamp() AS db_now
      FROM assignments
      WHERE id = ${assignmentId}::uuid AND deleted_at IS NULL
        AND (requester_id = ${userId}::uuid OR runner_id = ${userId}::uuid)
    `;
    const assignment = rows[0];
    if (!assignment) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    const ratings = await this.prisma.rating.findMany({ where: { assignmentId, deletedAt: null }, include: { scores: true } });
    const mine = ratings.find((r) => r.raterId === userId) ?? null;
    const theirs = ratings.find((r) => r.raterId !== userId) ?? null;

    const windowEnd = assignment.completed_at ? new Date(assignment.completed_at.getTime() + windowDays * DAY_MS) : null;
    let reason: string | null = null;
    if (assignment.status !== 'COMPLETED' || !windowEnd) reason = 'NOT_COMPLETED';
    else if (mine) reason = 'ALREADY_RATED';
    else if (assignment.db_now.getTime() >= windowEnd.getTime()) reason = 'WINDOW_CLOSED';

    return {
      canRate: reason === null,
      reason,
      windowEndsAt: windowEnd,
      mine: mine ? toRatingDto(mine, assignment.db_now) : null,
      theirs: theirs && theirs.revealedAt !== null && theirs.status === 'PUBLISHED' ? toRatingDto(theirs, assignment.db_now) : null,
      counterpartRated: theirs !== null,
    };
  }

  /** Published, revealed ratings of a user (Backend PRD 30.1). The rater shows as first name and last initial. */
  async listForUser(targetUserId: string, query: RatingListQueryDto): Promise<Paginated<ProfileRatingDto>> {
    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, deletedAt: null, status: { in: ['ACTIVE', 'DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] } },
      select: { id: true },
    });
    if (!target) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await this.prisma.rating.findMany({
      where: {
        rateeId: targetUserId,
        status: 'PUBLISHED',
        revealedAt: { not: null },
        deletedAt: null,
        ...this.starFilter(query),
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt as Date } }, { createdAt: cursor.createdAt as Date, id: { lt: cursor.id } }] }
          : {}),
      },
      include: { scores: true, rater: { select: { firstName: true, lastName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return new Paginated(
      page.map((row) => ({
        id: row.id,
        direction: row.direction,
        scores: toScoresView(row.scores),
        review: row.review,
        raterFirstName: row.rater.firstName,
        raterLastInitial: row.rater.lastName.charAt(0).toUpperCase(),
        createdAt: row.createdAt,
      })),
      {
        hasNextPage,
        ...(hasNextPage && last
          ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) }
          : {}),
      },
    );
  }

  /**
   * The signed-in user's reviews page: ratings received (published and revealed only) or given
   * (including ones the other side cannot see yet), newest first, optionally by overall stars.
   */
  async listMine(userId: string, query: MyRatingsQueryDto): Promise<Paginated<MyRatingDto>> {
    const given = query.direction === 'GIVEN';
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await this.prisma.rating.findMany({
      where: {
        ...(given ? { raterId: userId } : { rateeId: userId, status: 'PUBLISHED', revealedAt: { not: null } }),
        deletedAt: null,
        ...this.starFilter(query),
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt as Date } }, { createdAt: cursor.createdAt as Date, id: { lt: cursor.id } }] }
          : {}),
      },
      include: {
        scores: true,
        rater: { select: { firstName: true, lastName: true } },
        ratee: { select: { firstName: true, lastName: true } },
        assignment: { select: { errand: { select: { title: true } } } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return new Paginated(
      page.map((row) => {
        const other = given ? row.ratee : row.rater;
        return {
          id: row.id,
          assignmentId: row.assignmentId,
          errandTitle: row.assignment.errand.title,
          direction: row.direction,
          scores: toScoresView(row.scores),
          review: row.review,
          revealed: row.revealedAt !== null,
          counterpartFirstName: other.firstName,
          counterpartLastInitial: other.lastName.charAt(0).toUpperCase(),
          createdAt: row.createdAt,
        };
      }),
      {
        hasNextPage,
        ...(hasNextPage && last
          ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) }
          : {}),
      },
    );
  }

  /** `minStars` and `maxStars` bound the overall score. */
  private starFilter(query: { minStars?: number; maxStars?: number }): Prisma.RatingWhereInput {
    if (query.minStars === undefined && query.maxStars === undefined) {
      return {};
    }
    return {
      scores: {
        some: {
          dimension: 'OVERALL',
          score: {
            ...(query.minStars !== undefined ? { gte: query.minStars } : {}),
            ...(query.maxStars !== undefined ? { lte: query.maxStars } : {}),
          },
        },
      },
    };
  }

  // ---- Reveal at the end of the window (scheduler) ----

  /**
   * Reveal every unrevealed rating whose window has closed. A rating whose counterpart never
   * rated is revealed alone. Safe to run on several instances: rows are claimed with SKIP LOCKED.
   */
  async revealDue(batch = 100): Promise<number> {
    const windowDays = await this.config.get('RATING_WINDOW_DAYS');
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<Array<{ id: string; assignment_id: string; errand_id: string; rater_id: string; ratee_id: string; direction: string }>>`
        SELECT r.id::text, r.assignment_id::text, a.errand_id::text, r.rater_id::text, r.ratee_id::text, r.direction
        FROM ratings r
        JOIN assignments a ON a.id = r.assignment_id
        WHERE r.revealed_at IS NULL AND r.deleted_at IS NULL
          AND a.completed_at IS NOT NULL
          AND a.completed_at + make_interval(days => ${windowDays}::int) <= clock_timestamp()
        ORDER BY r.created_at
        LIMIT ${batch}
        FOR UPDATE OF r SKIP LOCKED
      `;
      if (due.length === 0) return 0;
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      await this.reveal(
        tx,
        due.map((r) => ({ id: r.id, assignmentId: r.assignment_id, errandId: r.errand_id, raterId: r.rater_id, rateeId: r.ratee_id, direction: r.direction })),
        'WINDOW_CLOSED',
        nowRows[0].now,
      );
      return due.length;
    });
  }

  // ---- Internals ----

  /** Mark ratings revealed, close their edit window, rebuild the ratees' aggregates, tell the ratees. */
  private async reveal(
    tx: Prisma.TransactionClient,
    ratings: Array<{ id: string; assignmentId: string; errandId: string; raterId: string; rateeId: string; direction: string }>,
    trigger: 'BOTH_SUBMITTED' | 'WINDOW_CLOSED',
    now: Date,
  ): Promise<void> {
    const ids = ratings.map((r) => r.id);
    await tx.$executeRaw`
      UPDATE ratings
      SET revealed_at = ${now}::timestamptz,
          editable_until = LEAST(editable_until, ${now}::timestamptz),
          updated_at = ${now}::timestamptz
      WHERE id = ANY(${ids}::uuid[]) AND revealed_at IS NULL
    `;
    for (const userId of new Set(ratings.map((r) => r.rateeId))) {
      await this.stats.recompute(tx, userId);
    }
    for (const rating of ratings) {
      await this.outbox.add(tx, {
        eventType: 'rating.revealed',
        aggregateType: 'rating',
        aggregateId: rating.id,
        payload: {
          ratingId: rating.id,
          assignmentId: rating.assignmentId,
          errandId: rating.errandId,
          raterId: rating.raterId,
          rateeId: rating.rateeId,
          direction: rating.direction,
          trigger,
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.SYSTEM,
        action: 'rating.revealed',
        entityType: 'rating',
        entityId: rating.id,
        metadata: { assignmentId: rating.assignmentId, trigger },
      });
    }
  }

  private async lockParty(tx: Prisma.TransactionClient, userId: string, assignmentId: string): Promise<AssignmentRow> {
    const rows = await tx.$queryRaw<AssignmentRow[]>`
      SELECT id::text, errand_id::text, requester_id::text, runner_id::text, status::text AS status, completed_at,
             clock_timestamp() AS db_now
      FROM assignments
      WHERE id = ${assignmentId}::uuid AND deleted_at IS NULL
        AND (requester_id = ${userId}::uuid OR runner_id = ${userId}::uuid)
      FOR UPDATE
    `;
    if (!rows[0]) {
      // Not a party, or no such assignment: the same answer.
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return rows[0];
  }

  private toScoreRows(scores: RatingScoresDto | undefined, requireOverall: boolean): Array<{ dimension: RatingDimension; score: number }> {
    const rows: Array<{ dimension: RatingDimension; score: number }> = [];
    for (const [field, dimension] of DIMENSION_FIELDS) {
      const value = scores?.[field];
      if (value === undefined || value === null) continue;
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        throw DomainException.of(VALIDATION_ERROR, { message: 'Scores are whole numbers from 1 to 5.', details: { field: `scores.${field}` } });
      }
      rows.push({ dimension, score: value });
    }
    if (requireOverall && !rows.some((r) => r.dimension === RatingDimension.OVERALL)) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'An overall score is required.', details: { field: 'scores.overall' } });
    }
    return rows;
  }

  private cleanReview(review: string | undefined): string | null {
    const text = review?.trim();
    return text ? text : null;
  }
}

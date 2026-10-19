import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { BlockService } from '../auth/block.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import type { ConversationDto, ConversationFilter } from './messaging.dto.js';

/** Errand statuses behind each tab of the conversation list. ALL has none. */
const FILTER_STATUSES: Record<ConversationFilter, string[] | undefined> = {
  ALL: undefined,
  ACTIVE: ['RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED', 'DISPUTED'],
  OFFERS: ['OPEN'],
  CLOSED: ['COMPLETED', 'CANCELLED', 'EXPIRED'],
};

export type ReadOnlyReason = 'BLOCKED' | 'ERRAND_ENDED' | 'NO_ACTIVE_OFFER' | 'NOT_ASSIGNED' | 'COMPLETION_WINDOW_ENDED';

export interface ConversationState {
  canSend: boolean;
  readOnlyReason: ReadOnlyReason | null;
  /** When chat closes after a completed errand; null while the errand is not completed. */
  closesAt?: Date | null;
}

export interface ConversationRow {
  id: string;
  errandId: string;
  requesterId: string;
  runnerId: string;
}

type Client = Prisma.TransactionClient | PrismaService;

/**
 * Conversations (Backend PRD 18.1). One per (errand, runner), created inside the transaction of
 * the runner's first offer so it can be linked, but it stays closed and hidden until the runner
 * accepts the assignment: before that, price and timing go through the offer's note and counters.
 * The two parties are the requester and that runner, and nobody else can read or write.
 */
@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly blocks: BlockService,
    private readonly cursors: CursorService,
  ) {}

  /**
   * Find or create the conversation for an offer, and both participants, in the caller's
   * transaction. A runner who withdraws and offers again keeps the same conversation.
   */
  async ensureForOffer(
    tx: Prisma.TransactionClient,
    input: { errandId: string; requesterId: string; runnerId: string; offerId: string },
  ): Promise<string> {
    const created = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO conversations (errand_id, requester_id, runner_id, offer_id, updated_at)
      VALUES (${input.errandId}::uuid, ${input.requesterId}::uuid, ${input.runnerId}::uuid, ${input.offerId}::uuid, now())
      ON CONFLICT (errand_id, runner_id) WHERE deleted_at IS NULL DO NOTHING
      RETURNING id::text
    `;
    let id = created[0]?.id;
    if (!id) {
      const existing = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM conversations
        WHERE errand_id = ${input.errandId}::uuid AND runner_id = ${input.runnerId}::uuid AND deleted_at IS NULL
      `;
      id = existing[0].id;
    }
    for (const userId of [input.requesterId, input.runnerId]) {
      await tx.$executeRaw`
        INSERT INTO conversation_participants (conversation_id, user_id, updated_at)
        VALUES (${id}::uuid, ${userId}::uuid, now())
        ON CONFLICT (conversation_id, user_id) WHERE deleted_at IS NULL DO NOTHING
      `;
    }
    return id;
  }

  /** The conversation, if the user is one of its two parties. Anyone else gets "not found". */
  async requireParty(client: Client, userId: string, conversationId: string): Promise<ConversationRow> {
    const row = await client.conversation.findFirst({
      where: { id: conversationId, OR: [{ requesterId: userId }, { runnerId: userId }] },
      select: { id: true, errandId: true, requesterId: true, runnerId: true },
    });
    if (!row) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return row;
  }

  /**
   * Whether messages may be sent now, derived from the current state of the offer, assignment and
   * errand (Backend PRD 18.1): enabled once the runner has accepted the assignment, disabled
   * before that (`NOT_ASSIGNED`), when the errand was cancelled or expired, when the assignment
   * ended, and `CHAT_POST_COMPLETION_DAYS` after completion. A block in either direction also
   * stops it.
   */
  async stateOf(client: Client, conversation: ConversationRow): Promise<ConversationState> {
    const days = await this.config.get('CHAT_POST_COMPLETION_DAYS');
    const rows = await client.$queryRaw<
      Array<{ errand_status: string; active_offer: boolean; live_assignment: boolean; accepted_assignment: boolean; completed_in_window: boolean; completed_any: boolean; completed_at: Date | null }>
    >`
      SELECT e.status::text AS errand_status,
        EXISTS (SELECT 1 FROM offers o WHERE o.errand_id = ${conversation.errandId}::uuid AND o.runner_id = ${conversation.runnerId}::uuid
                  AND o.status = 'ACTIVE'::"OfferStatus" AND o.deleted_at IS NULL) AS active_offer,
        EXISTS (SELECT 1 FROM assignments a WHERE a.errand_id = ${conversation.errandId}::uuid AND a.runner_id = ${conversation.runnerId}::uuid
                  AND a.status IN ('PENDING_ACCEPTANCE'::"AssignmentStatus", 'ACCEPTED'::"AssignmentStatus") AND a.deleted_at IS NULL) AS live_assignment,
        EXISTS (SELECT 1 FROM assignments a WHERE a.errand_id = ${conversation.errandId}::uuid AND a.runner_id = ${conversation.runnerId}::uuid
                  AND a.status = 'ACCEPTED'::"AssignmentStatus" AND a.deleted_at IS NULL) AS accepted_assignment,
        EXISTS (SELECT 1 FROM assignments a WHERE a.errand_id = ${conversation.errandId}::uuid AND a.runner_id = ${conversation.runnerId}::uuid
                  AND a.status = 'COMPLETED'::"AssignmentStatus" AND a.completed_at > now() - make_interval(days => ${days}::int)
                  AND a.deleted_at IS NULL) AS completed_in_window,
        EXISTS (SELECT 1 FROM assignments a WHERE a.errand_id = ${conversation.errandId}::uuid AND a.runner_id = ${conversation.runnerId}::uuid
                  AND a.status = 'COMPLETED'::"AssignmentStatus" AND a.deleted_at IS NULL) AS completed_any,
        (SELECT max(a.completed_at) FROM assignments a WHERE a.errand_id = ${conversation.errandId}::uuid AND a.runner_id = ${conversation.runnerId}::uuid
                  AND a.status = 'COMPLETED'::"AssignmentStatus" AND a.deleted_at IS NULL) AS completed_at
      FROM errands e WHERE e.id = ${conversation.errandId}::uuid
    `;
    const row = rows[0];
    if (await this.blocks.existsBetween(conversation.requesterId, conversation.runnerId)) {
      return { canSend: false, readOnlyReason: 'BLOCKED' };
    }
    if (!row) {
      return { canSend: false, readOnlyReason: 'ERRAND_ENDED' };
    }
    if (row.errand_status === 'CANCELLED' || row.errand_status === 'EXPIRED') {
      return { canSend: false, readOnlyReason: 'ERRAND_ENDED' };
    }
    if (row.accepted_assignment || row.completed_in_window) {
      const closesAt = row.completed_at ? new Date(row.completed_at.getTime() + days * 24 * 60 * 60 * 1000) : null;
      return { canSend: true, readOnlyReason: null, closesAt };
    }
    if (row.completed_any) return { canSend: false, readOnlyReason: 'COMPLETION_WINDOW_ENDED' };
    // Not assigned yet: a live offer or a selection waiting for the runner's answer.
    return { canSend: false, readOnlyReason: row.active_offer || row.live_assignment ? 'NOT_ASSIGNED' : 'NO_ACTIVE_OFFER' };
  }

  async list(
    userId: string,
    options: { filter?: ConversationFilter; q?: string; cursor?: string; limit?: number },
  ): Promise<Paginated<ConversationDto>> {
    const limit = options.limit ?? 20;
    const cursor = options.cursor ? this.cursors.decode(options.cursor) : undefined;
    const statuses = options.filter ? FILTER_STATUSES[options.filter] : undefined;
    const statusClause = statuses ? Prisma.sql`AND e.status::text = ANY(${statuses}::text[])` : Prisma.empty;
    const term = options.q?.trim();
    const like = term ? `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
    const searchClause = like ? Prisma.sql`AND (e.title ILIKE ${like} OR o.first_name ILIKE ${like} OR o.name ILIKE ${like})` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        errand_id: string;
        requester_id: string;
        runner_id: string;
        title: string;
        sort_at: Date;
        last_message_at: Date | null;
        created_at: Date;
        muted: boolean;
        unread: number;
        other_id: string;
        other_first_name: string;
        other_last_name: string | null;
        other_photo: string | null;
        other_role: 'REQUESTER' | 'RUNNER';
        other_rating_avg: number | null;
        other_rating_count: number;
        last_preview: string | null;
        errand_status: string;
        pickup_area: string | null;
        destination_area: string | null;
        assignment_id: string | null;
        agreed_minor: bigint | null;
        offer_minor: bigint | null;
      }>
    >`
      SELECT c.id::text, c.errand_id::text, c.requester_id::text, c.runner_id::text, e.title,
             COALESCE(c.last_message_at, c.created_at) AS sort_at, c.last_message_at, c.created_at,
             COALESCE(p.muted, false) AS muted,
             (SELECT count(*)::int FROM messages m
               WHERE m.conversation_id = c.id AND m.sender_id <> ${userId}::uuid AND m.read_at IS NULL
                 AND m.status <> 'REMOVED'::"MessageStatus" AND m.deleted_at IS NULL) AS unread,
             o.id::text AS other_id, o.first_name AS other_first_name, o.last_name AS other_last_name, pr.photo_media_id::text AS other_photo,
             CASE WHEN c.requester_id = ${userId}::uuid THEN 'RUNNER' ELSE 'REQUESTER' END AS other_role,
             CASE WHEN c.requester_id = ${userId}::uuid THEN us.runner_rating_avg ELSE us.requester_rating_avg END::float8 AS other_rating_avg,
             COALESCE(CASE WHEN c.requester_id = ${userId}::uuid THEN us.runner_rating_count ELSE us.requester_rating_count END, 0)::int AS other_rating_count,
             (SELECT CASE WHEN lm.type = 'IMAGE'::"MessageType" THEN 'Photo' ELSE left(COALESCE(lm.body, ''), 120) END
                FROM messages lm
               WHERE lm.conversation_id = c.id AND lm.status <> 'REMOVED'::"MessageStatus" AND lm.deleted_at IS NULL
               ORDER BY lm.created_at DESC, lm.id DESC LIMIT 1) AS last_preview,
             e.status::text AS errand_status,
             pl.area AS pickup_area, dl.area AS destination_area,
             asg.id::text AS assignment_id, asg.agreed_amount_minor AS agreed_minor,
             (SELECT lo.amount_minor FROM offers lo
               WHERE lo.errand_id = c.errand_id AND lo.runner_id = c.runner_id AND lo.deleted_at IS NULL
               ORDER BY lo.created_at DESC LIMIT 1) AS offer_minor
      FROM conversations c
      JOIN errands e ON e.id = c.errand_id
      LEFT JOIN errand_locations pl ON pl.errand_id = e.id AND pl.type = 'ERRAND_PICKUP'::"LocationType" AND pl.deleted_at IS NULL
      LEFT JOIN errand_locations dl ON dl.errand_id = e.id AND dl.type = 'ERRAND_DESTINATION'::"LocationType" AND dl.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT a.id, a.agreed_amount_minor FROM assignments a
        WHERE a.errand_id = c.errand_id AND a.runner_id = c.runner_id AND a.deleted_at IS NULL
          AND a.status IN ('PENDING_ACCEPTANCE'::"AssignmentStatus", 'ACCEPTED'::"AssignmentStatus", 'COMPLETED'::"AssignmentStatus")
        ORDER BY a.selected_at DESC LIMIT 1
      ) asg ON TRUE
      LEFT JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ${userId}::uuid AND p.deleted_at IS NULL
      JOIN users o ON o.id = CASE WHEN c.requester_id = ${userId}::uuid THEN c.runner_id ELSE c.requester_id END
      LEFT JOIN profiles pr ON pr.user_id = o.id AND pr.deleted_at IS NULL
      LEFT JOIN user_stats us ON us.user_id = o.id
      WHERE c.deleted_at IS NULL AND (c.requester_id = ${userId}::uuid OR c.runner_id = ${userId}::uuid)
        -- A conversation exists to the people in it only once the runner has accepted the errand.
        AND EXISTS (SELECT 1 FROM assignments ac WHERE ac.errand_id = c.errand_id AND ac.runner_id = c.runner_id
                      AND ac.accepted_at IS NOT NULL AND ac.deleted_at IS NULL)
        ${statusClause}
        ${searchClause}
        AND (${cursor ? cursor.createdAt : null}::timestamptz IS NULL
             OR COALESCE(c.last_message_at, c.created_at) < ${cursor ? cursor.createdAt : null}::timestamptz
             OR (COALESCE(c.last_message_at, c.created_at) = ${cursor ? cursor.createdAt : null}::timestamptz AND c.id < ${cursor ? cursor.id : null}::uuid))
      ORDER BY sort_at DESC, c.id DESC
      LIMIT ${limit + 1}
    `;
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const data: ConversationDto[] = [];
    const ratingMin = await this.config.get('RATING_MIN_COUNT_FOR_AVERAGE');
    for (const row of page) {
      const state = await this.stateOf(this.prisma, { id: row.id, errandId: row.errand_id, requesterId: row.requester_id, runnerId: row.runner_id });
      data.push({
        id: row.id,
        errandId: row.errand_id,
        errandTitle: row.title,
        counterpart: {
          userId: row.other_id,
          firstName: row.other_first_name,
          lastName: row.other_last_name,
          photoMediaId: row.other_photo,
          role: row.other_role,
          rating: row.other_rating_avg !== null && row.other_rating_count >= ratingMin ? Number(row.other_rating_avg) : null,
          ratingCount: row.other_rating_count,
        },
        lastMessagePreview: row.last_preview,
        errandStatus: row.errand_status,
        amountMinor: row.agreed_minor !== null ? Number(row.agreed_minor) : row.offer_minor !== null ? Number(row.offer_minor) : null,
        amountKind: row.agreed_minor !== null ? 'AGREED' : row.offer_minor !== null ? 'OFFER' : null,
        pickupArea: row.pickup_area,
        destinationArea: row.destination_area,
        assignmentId: row.assignment_id,
        lastMessageAt: row.last_message_at,
        unreadCount: row.unread,
        muted: row.muted,
        canSend: state.canSend,
        readOnlyReason: state.readOnlyReason,
        chatClosesAt: state.closesAt ?? null,
        createdAt: row.created_at,
      });
    }
    const last = page[page.length - 1];
    return new Paginated(data, {
      hasNextPage,
      ...(hasNextPage && last ? { nextCursor: this.cursors.encode({ sort: last.sort_at.toISOString(), createdAt: last.sort_at, id: last.id }) } : {}),
    });
  }

  async get(userId: string, conversationId: string): Promise<ConversationDto> {
    await this.requireParty(this.prisma, userId, conversationId);
    // Reuse the list query for one row: a page of the user's conversations is small and indexed.
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await this.list(userId, { cursor, limit: 50 });
      const found = page.items.find((c) => c.id === conversationId);
      if (found) return found;
      if (!page.meta.hasNextPage || !page.meta.nextCursor) break;
      cursor = page.meta.nextCursor;
    }
    throw DomainException.of(RESOURCE_NOT_FOUND);
  }

  async setMuted(userId: string, conversationId: string, muted: boolean): Promise<void> {
    await this.requireParty(this.prisma, userId, conversationId);
    await this.prisma.$executeRaw`
      UPDATE conversation_participants SET muted = ${muted}, updated_at = now()
      WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
    `;
  }
}

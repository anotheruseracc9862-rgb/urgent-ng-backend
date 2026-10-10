import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { BlockService } from '../auth/block.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import type { ConversationDto } from './messaging.dto.js';

export type ReadOnlyReason = 'BLOCKED' | 'ERRAND_ENDED' | 'NO_ACTIVE_OFFER' | 'COMPLETION_WINDOW_ENDED';

export interface ConversationState {
  canSend: boolean;
  readOnlyReason: ReadOnlyReason | null;
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
 * the runner's first offer, so price and timing can be discussed before selection. The two
 * parties are the requester and that runner, and nobody else can read or write.
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
   * errand (Backend PRD 18.1): enabled while the runner's offer is live or the assignment is
   * live, disabled when the offer closed without selection, when the errand was cancelled or
   * expired, and `CHAT_POST_COMPLETION_DAYS` after completion. A block in either direction also
   * stops it.
   */
  async stateOf(client: Client, conversation: ConversationRow): Promise<ConversationState> {
    const days = await this.config.get('CHAT_POST_COMPLETION_DAYS');
    const rows = await client.$queryRaw<
      Array<{ errand_status: string; active_offer: boolean; live_assignment: boolean; completed_in_window: boolean; completed_any: boolean }>
    >`
      SELECT e.status::text AS errand_status,
        EXISTS (SELECT 1 FROM offers o WHERE o.errand_id = ${conversation.errandId}::uuid AND o.runner_id = ${conversation.runnerId}::uuid
                  AND o.status = 'ACTIVE'::"OfferStatus" AND o.deleted_at IS NULL) AS active_offer,
        EXISTS (SELECT 1 FROM assignments a WHERE a.errand_id = ${conversation.errandId}::uuid AND a.runner_id = ${conversation.runnerId}::uuid
                  AND a.status IN ('PENDING_ACCEPTANCE'::"AssignmentStatus", 'ACCEPTED'::"AssignmentStatus") AND a.deleted_at IS NULL) AS live_assignment,
        EXISTS (SELECT 1 FROM assignments a WHERE a.errand_id = ${conversation.errandId}::uuid AND a.runner_id = ${conversation.runnerId}::uuid
                  AND a.status = 'COMPLETED'::"AssignmentStatus" AND a.completed_at > now() - make_interval(days => ${days}::int)
                  AND a.deleted_at IS NULL) AS completed_in_window,
        EXISTS (SELECT 1 FROM assignments a WHERE a.errand_id = ${conversation.errandId}::uuid AND a.runner_id = ${conversation.runnerId}::uuid
                  AND a.status = 'COMPLETED'::"AssignmentStatus" AND a.deleted_at IS NULL) AS completed_any
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
    if (row.live_assignment || row.active_offer || row.completed_in_window) {
      return { canSend: true, readOnlyReason: null };
    }
    return { canSend: false, readOnlyReason: row.completed_any ? 'COMPLETION_WINDOW_ENDED' : 'NO_ACTIVE_OFFER' };
  }

  async list(userId: string, options: { cursor?: string; limit?: number }): Promise<Paginated<ConversationDto>> {
    const limit = options.limit ?? 20;
    const cursor = options.cursor ? this.cursors.decode(options.cursor) : undefined;
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
        other_photo: string | null;
      }>
    >`
      SELECT c.id::text, c.errand_id::text, c.requester_id::text, c.runner_id::text, e.title,
             COALESCE(c.last_message_at, c.created_at) AS sort_at, c.last_message_at, c.created_at,
             COALESCE(p.muted, false) AS muted,
             (SELECT count(*)::int FROM messages m
               WHERE m.conversation_id = c.id AND m.sender_id <> ${userId}::uuid AND m.read_at IS NULL
                 AND m.status <> 'REMOVED'::"MessageStatus" AND m.deleted_at IS NULL) AS unread,
             o.id::text AS other_id, o.first_name AS other_first_name, pr.photo_media_id::text AS other_photo
      FROM conversations c
      JOIN errands e ON e.id = c.errand_id
      LEFT JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ${userId}::uuid AND p.deleted_at IS NULL
      JOIN users o ON o.id = CASE WHEN c.requester_id = ${userId}::uuid THEN c.runner_id ELSE c.requester_id END
      LEFT JOIN profiles pr ON pr.user_id = o.id AND pr.deleted_at IS NULL
      WHERE c.deleted_at IS NULL AND (c.requester_id = ${userId}::uuid OR c.runner_id = ${userId}::uuid)
        AND (${cursor ? cursor.createdAt : null}::timestamptz IS NULL
             OR COALESCE(c.last_message_at, c.created_at) < ${cursor ? cursor.createdAt : null}::timestamptz
             OR (COALESCE(c.last_message_at, c.created_at) = ${cursor ? cursor.createdAt : null}::timestamptz AND c.id < ${cursor ? cursor.id : null}::uuid))
      ORDER BY sort_at DESC, c.id DESC
      LIMIT ${limit + 1}
    `;
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const data: ConversationDto[] = [];
    for (const row of page) {
      const state = await this.stateOf(this.prisma, { id: row.id, errandId: row.errand_id, requesterId: row.requester_id, runnerId: row.runner_id });
      data.push({
        id: row.id,
        errandId: row.errand_id,
        errandTitle: row.title,
        counterpart: { userId: row.other_id, firstName: row.other_first_name, photoMediaId: row.other_photo },
        lastMessageAt: row.last_message_at,
        unreadCount: row.unread,
        muted: row.muted,
        canSend: state.canSend,
        readOnlyReason: state.readOnlyReason,
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

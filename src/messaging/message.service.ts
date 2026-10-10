import { Injectable } from '@nestjs/common';
import { Prisma, type Message } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { MediaService } from '../media/media.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { CONVERSATION_READ_ONLY, MEDIA_INVALID, MESSAGE_BLOCKED, RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import { ConversationService } from './conversation.service.js';
import type { MessageDto, SendMessageDto } from './messaging.dto.js';

/** What a viewer may see of a message. A removed message is a tombstone: no body, no file. */
export function toMessageDto(row: Message, viewerId: string): MessageDto {
  const removed = row.status === 'REMOVED';
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    type: row.type,
    body: removed ? null : row.body,
    mediaId: removed ? null : row.mediaId,
    status: row.status,
    clientMessageId: row.senderId === viewerId ? row.clientMessageId : null,
    deliveredAt: row.deliveredAt,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

/**
 * Messages (Backend PRD 18.2). Sending re-derives whether the conversation is writable from the
 * current offer, assignment and errand, so a closed conversation answers `CONVERSATION_READ_ONLY`
 * whatever the client believes. `clientMessageId` makes a retried send return the first message.
 */
@Injectable()
export class MessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly conversations: ConversationService,
    private readonly media: MediaService,
    private readonly cursors: CursorService,
  ) {}

  async send(userId: string, conversationId: string, input: SendMessageDto): Promise<MessageDto> {
    const conversation = await this.conversations.requireParty(this.prisma, userId, conversationId);

    // A retried send returns what was stored the first time, even if the conversation closed since.
    if (input.clientMessageId) {
      const existing = await this.prisma.client.message.findFirst({ where: { senderId: userId, clientMessageId: input.clientMessageId } });
      if (existing) {
        if (existing.conversationId !== conversationId) {
          throw DomainException.of(MESSAGE_BLOCKED, { message: 'That client message id was used in another conversation.' });
        }
        return toMessageDto(existing, userId);
      }
    }

    const state = await this.conversations.stateOf(this.prisma, conversation);
    if (!state.canSend) {
      throw DomainException.of(state.readOnlyReason === 'BLOCKED' ? MESSAGE_BLOCKED : CONVERSATION_READ_ONLY, {
        details: { reason: state.readOnlyReason },
      });
    }

    if (input.type === 'IMAGE') {
      await this.media.requireReadyOwned(userId, input.mediaId!, 'CHAT_IMAGE');
      const used = await this.prisma.client.message.findFirst({ where: { mediaId: input.mediaId }, select: { id: true } });
      if (used) {
        throw DomainException.of(MEDIA_INVALID, { message: 'This photo was already sent.' });
      }
    }

    const recipientId = conversation.requesterId === userId ? conversation.runnerId : conversation.requesterId;
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const message = await tx.message.create({
          data: {
            conversationId,
            senderId: userId,
            type: input.type,
            body: input.type === 'TEXT' ? input.body!.trim() : null,
            mediaId: input.type === 'IMAGE' ? input.mediaId : null,
            clientMessageId: input.clientMessageId,
          },
        });
        await tx.$executeRaw`
          UPDATE conversations SET last_message_at = ${message.createdAt}::timestamptz, updated_at = now()
          WHERE id = ${conversationId}::uuid
        `;
        await this.outbox.add(tx, {
          eventType: 'message.created',
          aggregateType: 'conversation',
          aggregateId: conversationId,
          payload: {
            messageId: message.id,
            conversationId,
            errandId: conversation.errandId,
            senderId: userId,
            recipientId,
            type: input.type,
          },
        });
        return message;
      });
      return toMessageDto(created, userId);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && input.clientMessageId) {
        // Two sends with the same client id raced: the unique index let one win.
        const winner = await this.prisma.client.message.findFirst({ where: { senderId: userId, clientMessageId: input.clientMessageId } });
        if (winner) return toMessageDto(winner, userId);
      }
      throw error;
    }
  }

  /** Newest first. Reading marks the other person's messages as delivered. */
  async list(userId: string, conversationId: string, options: { cursor?: string; limit?: number }): Promise<Paginated<MessageDto>> {
    await this.conversations.requireParty(this.prisma, userId, conversationId);
    const limit = options.limit ?? 30;
    const cursor = options.cursor ? this.cursors.decode(options.cursor) : undefined;
    // Reading is what delivers the other person's messages, so mark them before they are returned.
    await this.prisma.$executeRaw`
      UPDATE messages SET delivered_at = now(), status = 'DELIVERED'::"MessageStatus"
      WHERE conversation_id = ${conversationId}::uuid AND sender_id <> ${userId}::uuid
        AND delivered_at IS NULL AND status = 'SENT'::"MessageStatus" AND deleted_at IS NULL
    `;

    const rows = await this.prisma.client.message.findMany({
      where: {
        conversationId,
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt as Date } }, { createdAt: cursor.createdAt as Date, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;

    const last = page[page.length - 1];
    return new Paginated(page.map((row) => toMessageDto(row, userId)), {
      hasNextPage,
      ...(hasNextPage && last ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) } : {}),
    });
  }

  /** Mark the other person's messages as read, up to a message or all of them. Returns how many changed. */
  async markRead(userId: string, conversationId: string, upToMessageId?: string): Promise<number> {
    const conversation = await this.conversations.requireParty(this.prisma, userId, conversationId);
    const senderId = conversation.requesterId === userId ? conversation.runnerId : conversation.requesterId;
    return this.prisma.$transaction(async (tx) => {
      let upTo: { createdAt: Date; id: string } | null = null;
      if (upToMessageId) {
        upTo = await tx.message.findFirst({ where: { id: upToMessageId, conversationId }, select: { createdAt: true, id: true } });
        if (!upTo) {
          throw DomainException.of(RESOURCE_NOT_FOUND);
        }
      }
      const changed = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE messages
        SET read_at = now(), delivered_at = COALESCE(delivered_at, now()), status = 'READ'::"MessageStatus"
        WHERE conversation_id = ${conversationId}::uuid AND sender_id = ${senderId}::uuid
          AND read_at IS NULL AND status <> 'REMOVED'::"MessageStatus" AND deleted_at IS NULL
          AND (${upTo ? upTo.createdAt : null}::timestamptz IS NULL
               OR created_at < ${upTo ? upTo.createdAt : null}::timestamptz
               OR (created_at = ${upTo ? upTo.createdAt : null}::timestamptz AND id <= ${upTo ? upTo.id : null}::uuid))
        RETURNING id::text
      `;
      if (changed.length > 0) {
        const lastRead = upTo?.id ?? changed[changed.length - 1].id;
        await tx.$executeRaw`
          UPDATE conversation_participants SET last_read_message_id = ${lastRead}::uuid, updated_at = now()
          WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
        `;
        await this.outbox.add(tx, {
          eventType: 'message.read',
          aggregateType: 'conversation',
          aggregateId: conversationId,
          payload: { conversationId, errandId: conversation.errandId, userId: senderId, readerId: userId, count: changed.length },
        });
      }
      return changed.length;
    });
  }

  /** The sender removes their own message. It stays as a tombstone for audit and disputes. */
  async remove(userId: string, messageId: string): Promise<MessageDto> {
    const message = await this.prisma.client.message.findFirst({ where: { id: messageId, senderId: userId } });
    if (!message) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (message.status === 'REMOVED') {
      return toMessageDto(message, userId);
    }
    const updated = await this.prisma.client.message.update({
      where: { id: messageId },
      data: { status: 'REMOVED', removedAt: new Date(), removalReason: 'SENDER_DELETED' },
    });
    return toMessageDto(updated, userId);
  }
}

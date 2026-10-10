import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { MediaAccessService } from '../media/media-access.service.js';

/**
 * Who besides the sender may view a chat image (Backend PRD 23.4): the other party of the
 * conversation the message belongs to, unless the message was removed. A stranger gets "not found".
 */
@Injectable()
export class ConversationMediaAccess implements OnModuleInit {
  constructor(
    private readonly access: MediaAccessService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.access.register({
      purposes: ['CHAT_IMAGE'],
      canView: async (media, viewerId) => {
        const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT m.id::text FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE m.media_id = ${media.id}::uuid AND m.deleted_at IS NULL AND m.status <> 'REMOVED'::"MessageStatus"
            AND c.deleted_at IS NULL AND (c.requester_id = ${viewerId}::uuid OR c.runner_id = ${viewerId}::uuid)
          LIMIT 1
        `;
        return rows.length > 0;
      },
    });
  }
}

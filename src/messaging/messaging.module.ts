import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MediaModule } from '../media/media.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { ConversationMediaAccess } from './conversation-media.access.js';
import { ConversationService } from './conversation.service.js';
import { MessageService } from './message.service.js';
import { MessagingController } from './messaging.controller.js';

/**
 * Conversations and messages (Backend PRD 18). OffersModule imports this module to open the
 * conversation inside the offer transaction; this module must never import OffersModule.
 */
@Module({
  imports: [AuthModule, ConfigStoreModule, DatabaseModule, MediaModule, QueueModule],
  controllers: [MessagingController],
  providers: [ConversationService, MessageService, ConversationMediaAccess],
  exports: [ConversationService],
})
export class MessagingModule {}

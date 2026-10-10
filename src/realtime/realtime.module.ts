import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { EventsController } from './events.controller.js';
import { RealtimeEventHandler } from './realtime-event.handler.js';
import { RealtimeStreamService } from './realtime-stream.service.js';
import { RealtimeTicketService } from './realtime-ticket.service.js';
import { RealtimeService } from './realtime.service.js';
import { SseAuthGuard } from './sse-auth.guard.js';

/** Per-user Redis streams and server-sent events (Backend PRD 19.5). */
@Module({
  imports: [AuthModule, ConfigStoreModule, DatabaseModule, QueueModule],
  controllers: [EventsController],
  providers: [RealtimeService, RealtimeStreamService, RealtimeTicketService, SseAuthGuard, RealtimeEventHandler],
  exports: [RealtimeService, RealtimeStreamService],
})
export class RealtimeModule {}

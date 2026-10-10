import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { NotificationEventHandler } from './notification.handler.js';
import { NotificationQueryService } from './notification-query.service.js';
import { NotificationRules } from './notification-rules.js';
import { NotificationService } from './notification.service.js';
import { NotificationsController } from './notifications.controller.js';
import { ReminderService } from './reminder.service.js';
import { ConfigStoreModule } from '../config/config-store.module.js';

/** The notification engine and the in-app list (Backend PRD 19). */
@Module({
  imports: [AuthModule, ConfigStoreModule, DatabaseModule, QueueModule, RealtimeModule],
  controllers: [NotificationsController],
  providers: [NotificationRules, NotificationService, NotificationQueryService, NotificationEventHandler, ReminderService],
  exports: [NotificationService, ReminderService],
})
export class NotificationsModule {}

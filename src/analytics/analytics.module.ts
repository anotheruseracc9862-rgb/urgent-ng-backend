import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { AnalyticsService } from './analytics.service.js';
import { AnalyticsEventHandler } from './analytics-event.handler.js';

@Module({
  imports: [QueueModule],
  providers: [AnalyticsService, AnalyticsEventHandler],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}

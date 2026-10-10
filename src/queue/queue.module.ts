import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DatabaseModule } from '../database/database.module.js';
import { OutboxService } from './outbox.service.js';
import { OutboxPublisher } from './outbox.publisher.js';
import { QUEUE_NAMES } from './queue.registry.js';
import { DelayedJobHelper } from './delayed-job.helper.js';
import { EventDispatcher } from './event-dispatcher.js';
import { EventWorkers } from './event-workers.js';

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue(
      ...Object.values(QUEUE_NAMES).map((name) => ({ name })),
    ),
  ],
  providers: [OutboxService, OutboxPublisher, DelayedJobHelper, EventDispatcher, EventWorkers],
  exports: [OutboxService, OutboxPublisher, DelayedJobHelper, EventDispatcher, EventWorkers, BullModule],
})
export class QueueModule {}

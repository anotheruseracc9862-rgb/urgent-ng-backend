import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OutboxEventRow, OutboxService } from './outbox.service.js';
import { getQueueForEvent } from './queue.registry.js';

/**
 * Moves outbox events into BullMQ. Runs in the worker process only.
 *
 * The BullMQ job id is the outbox event id, so publishing the same event twice
 * (lease recovery after a crash) never creates a duplicate job.
 */
@Injectable()
export class OutboxPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly moduleRef: ModuleRef,
  ) {}

  start(): void {
    this.outbox.startPublisher((event) => this.publish(event));
  }

  stop(): void {
    this.outbox.stopPublisher();
  }

  async publish(event: OutboxEventRow): Promise<void> {
    const queueName = getQueueForEvent(event.eventType);
    const queue = this.moduleRef.get<Queue>(getQueueToken(queueName), {
      strict: false,
    });

    await queue.add(
      event.eventType,
      {
        eventId: event.id,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: event.payload,
        occurredAt: event.occurredAt,
      },
      {
        jobId: event.id,
        removeOnComplete: { age: 24 * 3600, count: 10_000 },
        removeOnFail: { age: 7 * 24 * 3600 },
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      },
    );
    this.logger.debug(`Published ${event.eventType} ${event.id} to ${queueName}`);
  }

  onModuleDestroy(): void {
    this.stop();
  }
}

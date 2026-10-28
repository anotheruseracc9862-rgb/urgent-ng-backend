import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { redisOptionsFromUrl } from '../common/redis/redis.config.js';
import { EventDispatcher, type DomainEvent } from './event-dispatcher.js';
import { EVENT_TO_QUEUE_MAP, QUEUE_NAMES } from './queue.registry.js';

/** The media queue has its own worker (MediaWorker); two workers on one queue would split its jobs. */
const OWN_WORKER: readonly string[] = [QUEUE_NAMES.MEDIA];

/**
 * One BullMQ worker per queue that carries domain events. Every job goes to the dispatcher, so a
 * handler sees an event whichever queue the registry routed it to. Started by the worker process
 * only (`app.get(EventWorkers).start()`), never by the API.
 */
@Injectable()
export class EventWorkers implements OnModuleDestroy {
  private readonly logger = new Logger(EventWorkers.name);
  private workers: Worker[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly dispatcher: EventDispatcher,
  ) {}

  start(): void {
    if (this.workers.length > 0) {
      return;
    }
    const connection = redisOptionsFromUrl(this.config.getOrThrow<string>('redis.url')) as ConnectionOptions;
    const queues = [...new Set(Object.values(EVENT_TO_QUEUE_MAP))].filter((name) => !OWN_WORKER.includes(name));
    for (const queue of queues) {
      const worker = new Worker<DomainEvent>(
        queue,
        async (job: Job<DomainEvent>) => this.dispatcher.dispatch(job.data),
        { connection, concurrency: 4 },
      );
      worker.on('failed', (job, error) => {
        this.logger.warn(`${queue} job ${job?.id ?? '?'} failed (attempt ${job?.attemptsMade ?? '?'}): ${error.message}`);
      });
      worker.on('error', (error) => {
        this.logger.warn(`${queue} worker connection: ${error.message}`);
      });
      this.workers.push(worker);
    }
    this.logger.log(`Event workers started for: ${queues.join(', ')}; handlers: ${this.dispatcher.registered.join(', ') || 'none'}`);
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    this.workers = [];
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }
}

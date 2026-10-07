import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue.registry.js';
import { BaseConsumer, type JobContext } from '../queue/base.consumer.js';
import { redisOptionsFromUrl } from '../common/redis/redis.config.js';
import { MediaProcessingService } from './media-processing.service.js';

interface MediaJobData {
  payload?: { mediaId?: string };
}

/** Processes one `media.confirmed` job. Idempotent: the service ignores media that is no longer PROCESSING. */
class MediaConsumer extends BaseConsumer<MediaJobData> {
  constructor(private readonly processing: MediaProcessingService) {
    super('MediaConsumer');
  }

  async process({ data }: JobContext<MediaJobData>): Promise<void> {
    const mediaId = data.payload?.mediaId;
    if (!mediaId) {
      this.logger.error('Media job without a mediaId was dropped');
      return;
    }
    const outcome = await this.processing.process(mediaId);
    this.logger.debug(`Media ${mediaId}: ${outcome}`);
  }
}

/**
 * The BullMQ worker for the `media` queue. Started by the worker process only
 * (`app.get(MediaWorker).start()`), never by the API.
 */
@Injectable()
export class MediaWorker implements OnModuleDestroy {
  private readonly logger = new Logger(MediaWorker.name);
  private readonly consumer: MediaConsumer;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly processing: MediaProcessingService,
  ) {
    this.consumer = new MediaConsumer(processing);
  }

  start(): void {
    if (this.worker) {
      return;
    }
    const connection = redisOptionsFromUrl(this.config.getOrThrow<string>('redis.url')) as ConnectionOptions;
    this.worker = new Worker<MediaJobData>(
      QUEUE_NAMES.MEDIA,
      (job: Job<MediaJobData>) =>
        this.consumer.handle({ id: job.id ?? '', data: job.data, attemptsMade: job.attemptsMade }),
      { connection, concurrency: 4 },
    );
    this.worker.on('failed', (job, error) => {
      void this.onFailed(job, error);
    });
    this.logger.log('Media worker started');
  }

  /** After the last attempt the owner sees a rejection instead of a file stuck in PROCESSING. */
  private async onFailed(job: Job<MediaJobData> | undefined, error: Error): Promise<void> {
    const mediaId = job?.data.payload?.mediaId;
    const attempts = job?.opts.attempts ?? 1;
    if (!job || !mediaId || job.attemptsMade < attempts) {
      return;
    }
    try {
      await this.processing.markFailed(mediaId);
    } catch (markError) {
      this.logger.error(`Could not mark media ${mediaId} failed after "${error.message}": ${String(markError)}`);
    }
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }
}

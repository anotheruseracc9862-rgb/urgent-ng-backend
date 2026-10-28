import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { redisOptionsFromUrl } from './redis.config.js';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
/** One connection shared by every BullMQ queue (producer side) of this process. */
export const BULL_PRODUCER_CONNECTION = Symbol('BULL_PRODUCER_CONNECTION');
/** One connection shared by every BullMQ worker of this process; each worker adds one blocking connection. */
export const BULL_WORKER_CONNECTION = Symbol('BULL_WORKER_CONNECTION');

/**
 * One shared Redis client for caching, health checks and rate limiting.
 * It fails fast when Redis is down (no offline queue) so callers can degrade
 * to PostgreSQL, because Redis never holds business state (Backend PRD 3.3).
 *
 * BullMQ would open its own connections per queue (about 13) and two per worker. Hosted Redis plans
 * cap connections (the free tier allows 30), so queues and workers share one connection each:
 * a process then holds a handful of connections instead of about thirty.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const url = config.getOrThrow<string>('redis.url');
        const client = new Redis({
          ...redisOptionsFromUrl(url),
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 2000,
        });
        // A down Redis must not crash the process with an unhandled 'error' event.
        client.on('error', () => undefined);

        // Wait (briefly) for the connection so the first request after boot does not
        // hit a half-open client. If Redis is down we continue without it: callers
        // degrade to PostgreSQL and the client reconnects in the background.
        if (client.status !== 'ready') {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 3000);
            client.once('ready', () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        return client;
      },
    },
    {
      provide: BULL_PRODUCER_CONNECTION,
      inject: [ConfigService],
      // BullMQ's own defaults for a producer: commands wait out a reconnect instead of failing at once.
      useFactory: (config: ConfigService) => {
        const client = new Redis(redisOptionsFromUrl(config.getOrThrow<string>('redis.url')));
        client.on('error', () => undefined);
        return client;
      },
    },
    {
      provide: BULL_WORKER_CONNECTION,
      inject: [ConfigService],
      // Workers need maxRetriesPerRequest null (BullMQ blocks on it). Lazy: the API never starts a
      // worker, so it never opens this connection.
      useFactory: (config: ConfigService) => {
        const client = new Redis({
          ...redisOptionsFromUrl(config.getOrThrow<string>('redis.url')),
          maxRetriesPerRequest: null,
          lazyConnect: true,
        });
        client.on('error', () => undefined);
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT, BULL_PRODUCER_CONNECTION, BULL_WORKER_CONNECTION],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    @Inject(BULL_PRODUCER_CONNECTION) private readonly producer: Redis,
    @Inject(BULL_WORKER_CONNECTION) private readonly worker: Redis,
  ) {}

  /** BullMQ does not close a connection it was handed, so the queues and workers have stopped by now. */
  async onApplicationShutdown(): Promise<void> {
    this.client.disconnect();
    this.producer.disconnect();
    this.worker.disconnect();
  }
}

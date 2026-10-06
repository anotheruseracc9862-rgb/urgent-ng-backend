import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { redisOptionsFromUrl } from './redis.config.js';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * One shared Redis client for caching, health checks and rate limiting.
 * It fails fast when Redis is down (no offline queue) so callers can degrade
 * to PostgreSQL, because Redis never holds business state (Backend PRD 3.3).
 * BullMQ creates its own connections from the same URL.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.getOrThrow<string>('redis.url');
        const client = new Redis({
          ...redisOptionsFromUrl(url),
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 2000,
        });
        // A down Redis must not crash the process with an unhandled 'error' event.
        client.on('error', () => undefined);
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    this.client.disconnect();
  }
}

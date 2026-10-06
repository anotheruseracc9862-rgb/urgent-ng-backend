import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import { RATE_LIMIT_POLICIES } from '../decorators/rate-limit.decorator.js';

/**
 * Rate limiting backed by Redis. The default (unnamed) policy is the global
 * 300 per minute; routes opt into stricter named policies with @RateLimit.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => ({
        throttlers: [RATE_LIMIT_POLICIES.global],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
  ],
  exports: [ThrottlerModule],
})
export class AppThrottlerModule {}

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
        // Only honoured in tests (NODE_ENV=test), so HTTP tests can log in many times.
        skipIf: () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_DISABLED === 'true',
      }),
    }),
  ],
  exports: [ThrottlerModule],
})
export class AppThrottlerModule {}

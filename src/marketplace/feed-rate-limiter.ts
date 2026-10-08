import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RATE_LIMITED } from '../common/constants/error-codes.js';

/**
 * Per-user limit on feed and map requests (Backend PRD 17.2, default 60 per minute, config
 * `RATE_FEED_PER_MIN`). Counted per signed-in user rather than per address: the global throttler
 * runs before sign-in, so it cannot tell users behind one IP apart. Many requests from one user
 * is how an errand's position would be probed.
 *
 * Redis down: the request is allowed (rate limiting is a safeguard, not a gate).
 */
@Injectable()
export class FeedRateLimiter {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: BusinessConfigService,
  ) {}

  async consume(userId: string): Promise<void> {
    if (process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_DISABLED === 'true') {
      return;
    }
    const limit = await this.config.get('RATE_FEED_PER_MIN');
    const bucket = Math.floor(Date.now() / 60_000);
    const key = `ratelimit:feed:${userId}:${bucket}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, 120);
      }
      if (count > limit) {
        throw DomainException.of(RATE_LIMITED, { details: { limitPerMinute: limit } });
      }
    } catch (error) {
      if (error instanceof DomainException) throw error;
    }
  }
}

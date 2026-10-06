import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;
import { Redis } from 'ioredis';

/**
 * Atomic fixed-window counter with optional block period.
 * KEYS[1] = hit counter, KEYS[2] = block flag
 * ARGV    = ttl ms, limit, block duration ms
 * Returns { totalHits, ttlMs, isBlocked, blockTtlMs }
 */
const INCREMENT_SCRIPT = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  local current = tonumber(redis.call('GET', KEYS[1]) or '0')
  return { current, redis.call('PTTL', KEYS[1]), 1, blockTtl }
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
local blockDuration = tonumber(ARGV[3])
if hits > tonumber(ARGV[2]) and blockDuration > 0 then
  redis.call('SET', KEYS[2], '1', 'PX', blockDuration)
  return { hits, ttl, 1, blockDuration }
end
return { hits, ttl, 0, 0 }
`;

/**
 * Redis-backed storage for @nestjs/throttler so limits hold across API
 * instances and survive restarts (Backend PRD section 3.3 and 30).
 *
 * If Redis is unreachable it fails open (the request is allowed) rather than
 * taking the whole API down; abuse protection is best-effort, never a
 * dependency of availability.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;

    try {
      const [totalHits, ttlMs, blocked, blockTtlMs] = (await this.redis.eval(
        INCREMENT_SCRIPT,
        2,
        hitKey,
        blockKey,
        ttl,
        limit,
        blockDuration,
      )) as [number, number, number, number];

      return {
        totalHits,
        timeToExpire: Math.max(Math.ceil(ttlMs / 1000), 0),
        isBlocked: blocked === 1 || totalHits > limit,
        timeToBlockExpire: Math.max(Math.ceil(blockTtlMs / 1000), 0),
      };
    } catch (error) {
      this.logger.warn(`Rate limit storage unavailable, allowing request: ${String(error)}`);
      return { totalHits: 1, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}

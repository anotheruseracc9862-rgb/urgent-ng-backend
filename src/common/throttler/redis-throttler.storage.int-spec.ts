import { describe, it, expect, beforeEach } from 'vitest';
import { Redis } from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import { cleanRedis, getTestRedis } from '../../test/database.helper.js';

describe('RedisThrottlerStorage (integration)', () => {
  let storage: RedisThrottlerStorage;

  beforeEach(async () => {
    await cleanRedis();
    storage = new RedisThrottlerStorage(getTestRedis());
  });

  it('counts hits inside the window and reports blocked past the limit', async () => {
    const first = await storage.increment('ip-1', 60_000, 2, 0, 'default');
    const second = await storage.increment('ip-1', 60_000, 2, 0, 'default');
    const third = await storage.increment('ip-1', 60_000, 2, 0, 'default');

    expect([first.totalHits, second.totalHits, third.totalHits]).toEqual([1, 2, 3]);
    expect(first.isBlocked).toBe(false);
    expect(second.isBlocked).toBe(false);
    expect(third.isBlocked).toBe(true);
    expect(third.timeToExpire).toBeGreaterThan(0);
    expect(third.timeToExpire).toBeLessThanOrEqual(60);
  });

  it('sets the window expiry only once (a fixed window, not a sliding one)', async () => {
    await storage.increment('ip-2', 60_000, 10, 0, 'default');
    const ttlBefore = await getTestRedis().pttl('throttle:default:ip-2');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await storage.increment('ip-2', 60_000, 10, 0, 'default');
    const ttlAfter = await getTestRedis().pttl('throttle:default:ip-2');

    expect(ttlAfter).toBeLessThan(ttlBefore);
  });

  it('expires the window', async () => {
    await storage.increment('ip-3', 200, 1, 0, 'default');
    await storage.increment('ip-3', 200, 1, 0, 'default');
    // Three times the window: a loaded machine can be slow to wake this timer, and the test is
    // about the window ending, not about how exactly it ends.
    await new Promise((resolve) => setTimeout(resolve, 600));

    const next = await storage.increment('ip-3', 200, 1, 0, 'default');
    expect(next.totalHits).toBe(1);
    expect(next.isBlocked).toBe(false);
  });

  it('isolates keys and throttler names', async () => {
    await storage.increment('ip-4', 60_000, 1, 0, 'default');
    await storage.increment('ip-4', 60_000, 1, 0, 'default');

    expect((await storage.increment('ip-5', 60_000, 1, 0, 'default')).isBlocked).toBe(false);
    expect((await storage.increment('ip-4', 60_000, 1, 0, 'other')).isBlocked).toBe(false);
  });

  it('keeps a block active for the block duration even after the window ends', async () => {
    await storage.increment('ip-6', 100, 1, 1000, 'default');
    const blocked = await storage.increment('ip-6', 100, 1, 1000, 'default');
    expect(blocked.isBlocked).toBe(true);
    expect(blocked.timeToBlockExpire).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 200)); // window over, block still on
    const still = await storage.increment('ip-6', 100, 1, 1000, 'default');
    expect(still.isBlocked).toBe(true);
  });

  it('counts concurrent hits atomically', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => storage.increment('ip-7', 60_000, 100, 0, 'default')),
    );

    expect(results.map((r) => r.totalHits).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it('fails open (allows the request) when Redis is unreachable', async () => {
    const dead = new Redis({
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    dead.on('error', () => undefined);

    const result = await new RedisThrottlerStorage(dead).increment('ip-8', 60_000, 1, 0, 'default');

    expect(result.isBlocked).toBe(false);
    dead.disconnect();
  });
});

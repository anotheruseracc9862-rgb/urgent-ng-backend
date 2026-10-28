import type { RedisOptions } from 'ioredis';

/**
 * Turn a Redis URL into ioredis / BullMQ connection options.
 *
 * Every Redis connection in the app (BullMQ, config cache, health, rate
 * limiting, SSE later) must be built from the one REDIS_URL through this
 * function so that the username, password, database index and TLS
 * (`rediss://`) are never dropped.
 *
 *   redis://localhost:6399          plain
 *   redis://:secret@host:6379/2     password, database 2
 *   rediss://user:secret@host:6380  TLS, ACL user and password
 */
export function redisOptionsFromUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must start with redis:// or rediss://');
  }

  const dbPath = parsed.pathname.replace(/^\//, '');
  const db = dbPath === '' ? 0 : Number.parseInt(dbPath, 10);
  if (Number.isNaN(db) || db < 0) {
    throw new Error('REDIS_URL database index must be a non-negative number');
  }

  return {
    host: parsed.hostname,
    port: Number.parseInt(parsed.port || '6379', 10),
    ...(parsed.username
      ? { username: decodeURIComponent(parsed.username) }
      : {}),
    ...(parsed.password
      ? { password: decodeURIComponent(parsed.password) }
      : {}),
    db,
    // Probe idle sockets every 10 s so a proxy or load balancer in front of a hosted Redis does not
    // drop them for being quiet (the default waits for the operating system, about two hours).
    keepAlive: 10_000,
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

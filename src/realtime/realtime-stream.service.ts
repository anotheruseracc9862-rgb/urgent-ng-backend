import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { redisOptionsFromUrl } from '../common/redis/redis.config.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RATE_LIMITED } from '../common/constants/error-codes.js';
import { streamKey, type RealtimeEnvelope } from './realtime.service.js';

/** One server-sent frame. `id` is absent for frames that must not move `Last-Event-ID` (heartbeat, resync). */
export type SseFrame =
  | { kind: 'event'; id: string; envelope: RealtimeEnvelope }
  | { kind: 'resync'; envelope: RealtimeEnvelope }
  | { kind: 'heartbeat' };

export interface StreamOptions {
  /** Block for at most this long waiting for events, then send a heartbeat. PRD: every 25 s. */
  heartbeatMs?: number;
  /** At most this many open connections per user. PRD: 5. */
  maxConnections?: number;
}

const CONNECTION_TTL_MS = 90_000;
const ID_PATTERN = /^(\d+)-(\d+)$/;

const compareIds = (a: string, b: string): number => {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am === bm ? as - bs : am - bm;
};

/**
 * Reads a user's realtime stream for one SSE connection (Backend PRD 19.5).
 *
 *  - First connection (no `Last-Event-ID`): start after the newest entry, so only new events flow.
 *  - Reconnection within the window: replay every entry after the given id.
 *  - Reconnection outside the window (the id is older than the oldest kept entry, the stream is
 *    gone, or the id is not one of ours): send `resync` and carry on from the newest entry. The
 *    client refetches current state, because a missed event cannot be reconstructed.
 *
 * Each connection uses its own Redis connection for the blocking read; it is closed when the
 * client goes away.
 */
@Injectable()
export class RealtimeStreamService {
  private readonly logger = new Logger(RealtimeStreamService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Reserve a connection slot. Throws RATE_LIMITED when the user is at the cap. */
  async acquireSlot(userId: string, max: number): Promise<string> {
    const key = `rt:conns:${userId}`;
    const now = Date.now();
    const id = randomUUID();
    // One atomic step: drop stale slots, refuse at the cap, otherwise take a slot. Two connections
    // opening together can never both pass the check.
    const taken = await this.redis.eval(
      `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1] - ARGV[4])
       if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
       redis.call('ZADD', KEYS[1], ARGV[1], ARGV[3])
       redis.call('EXPIRE', KEYS[1], 3600)
       return 1`,
      1,
      key,
      now,
      max,
      id,
      CONNECTION_TTL_MS,
    );
    if (taken !== 1) {
      throw DomainException.of(RATE_LIMITED, { message: 'Too many open connections. Close another tab or device first.', details: { max } });
    }
    return id;
  }

  async refreshSlot(userId: string, slotId: string): Promise<void> {
    await this.redis.zadd(`rt:conns:${userId}`, Date.now(), slotId).catch(() => undefined);
  }

  async releaseSlot(userId: string, slotId: string): Promise<void> {
    await this.redis.zrem(`rt:conns:${userId}`, slotId).catch(() => undefined);
  }

  /**
   * The frames of one connection. Ends when `signal` aborts. Throws if Redis is unreachable so
   * the controller can answer 503 instead of holding an empty stream open.
   */
  async *frames(userId: string, lastEventId: string | undefined, signal: AbortSignal, options: StreamOptions = {}): AsyncGenerator<SseFrame> {
    const heartbeatMs = options.heartbeatMs ?? 25_000;
    const key = streamKey(userId);
    const reader = new Redis({
      ...redisOptionsFromUrl(this.config.getOrThrow<string>('redis.url')),
      maxRetriesPerRequest: 1,
    });
    reader.on('error', () => undefined);
    const onAbort = (): void => {
      reader.disconnect();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      let cursor = await this.newestId(key);
      if (lastEventId !== undefined) {
        const verdict = await this.replayable(key, lastEventId);
        if (verdict === 'ok') {
          cursor = lastEventId;
        } else {
          yield {
            kind: 'resync',
            envelope: { id: '', type: 'resync', occurredAt: new Date().toISOString(), data: { reason: verdict }, version: 1 },
          };
        }
      }

      while (!signal.aborted) {
        let result: Array<[string, Array<[string, string[]]>]> | null;
        try {
          result = (await reader.xread('BLOCK', heartbeatMs, 'STREAMS', key, cursor)) as typeof result;
        } catch (error) {
          if (signal.aborted) return;
          throw error;
        }
        if (!result) {
          yield { kind: 'heartbeat' };
          continue;
        }
        for (const [, entries] of result) {
          for (const [id, fields] of entries) {
            cursor = id;
            yield { kind: 'event', id, envelope: this.toEnvelope(id, fields) };
          }
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      reader.disconnect();
    }
  }

  /** The newest entry id, or `0-0` for an empty stream (so every later entry is "new"). */
  private async newestId(key: string): Promise<string> {
    const newest = await this.redis.xrevrange(key, '+', '-', 'COUNT', 1);
    return newest[0]?.[0] ?? '0-0';
  }

  /** Whether everything after `lastEventId` is still in the stream. */
  private async replayable(key: string, lastEventId: string): Promise<'ok' | 'INVALID_ID' | 'TOO_OLD' | 'NO_STREAM'> {
    if (!ID_PATTERN.test(lastEventId)) return 'INVALID_ID';
    const oldest = await this.redis.xrange(key, '-', '+', 'COUNT', 1);
    if (oldest.length === 0) return 'NO_STREAM';
    // Entries older than the oldest kept one were trimmed: we cannot know what was lost.
    return compareIds(lastEventId, oldest[0][0]) < 0 ? 'TOO_OLD' : 'ok';
  }

  private toEnvelope(id: string, fields: string[]): RealtimeEnvelope {
    const map = new Map<string, string>();
    for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i], fields[i + 1]);
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(map.get('data') ?? '{}') as Record<string, unknown>;
    } catch {
      this.logger.warn(`Realtime entry ${id} has unreadable data`);
    }
    return { id, type: map.get('type') ?? 'unknown', occurredAt: map.get('occurredAt') ?? new Date(0).toISOString(), data, version: 1 };
  }
}

import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { redisOptionsFromUrl } from '../common/redis/redis.config.js';
import { streamKey, type RealtimeEnvelope } from './realtime.service.js';

/** One server-sent frame. `id` is absent for frames that must not move `Last-Event-ID` (heartbeat, resync). */
export type SseFrame =
  | { kind: 'event'; id: string; envelope: RealtimeEnvelope }
  | { kind: 'resync'; envelope: RealtimeEnvelope }
  | { kind: 'heartbeat' };

export interface StreamOptions {
  /** Send a heartbeat after this long without an event. PRD: every 25 s. */
  heartbeatMs?: number;
}

type XreadResult = Array<[string, Array<[string, string[]]>]> | null;

/** One open SSE connection, waiting on its in-memory queue. */
interface Subscriber {
  /** Events with an id above this arrive through the shared reader; everything up to it is replayed. */
  base: string;
  queue: SseFrame[];
  wake?: () => void;
  failed?: Error;
}

/** One user's stream as seen by the shared reader. */
interface Channel {
  /** Newest id the shared reader has seen for this stream. */
  cursor: string;
  subscribers: Set<Subscriber>;
}

const CONNECTION_TTL_MS = 90_000;
/** How long the shared reader blocks before it picks up streams added since its last read. */
const HUB_BLOCK_MS = 1_000;
/** A connection that falls this far behind is told to resync instead of buffering without limit. */
const MAX_QUEUED_FRAMES = 500;
/** Consecutive failed reads of the shared reader before the open connections are told to give up. */
const MAX_READER_FAILURES = 8;
const ID_PATTERN = /^(\d+)-(\d+)$/;

const compareIds = (a: string, b: string): number => {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am === bm ? as - bs : am - bm;
};

/**
 * Reads users' realtime streams for SSE connections (Backend PRD 19.5).
 *
 *  - First connection (no `Last-Event-ID`): start after the newest entry, so only new events flow.
 *  - Reconnection within the window: replay every entry after the given id.
 *  - Reconnection outside the window (the id is older than the oldest kept entry, the stream is
 *    gone, or the id is not one of ours): send `resync` and carry on from the newest entry. The
 *    client refetches current state, because a missed event cannot be reconstructed.
 *
 * Live reads share ONE Redis connection per server process: a single blocking XREAD over every
 * stream that has an open connection, fanned out in memory. Redis connections therefore grow with
 * server instances, not with users.
 */
@Injectable()
export class RealtimeStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeStreamService.name);
  private readonly channels = new Map<string, Channel>();
  private reader: Redis | undefined;
  private running = false;
  private closing = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleDestroy(): void {
    this.closing = true;
    this.reader?.disconnect();
    for (const channel of this.channels.values()) {
      for (const subscriber of channel.subscribers) subscriber.wake?.();
    }
  }

  /**
   * Reserve a connection slot. At the cap the oldest slot is dropped to make room: a new connection
   * from a real user nearly always replaces one that died without a clean close, and the old
   * connection ends itself on its next heartbeat (see `refreshSlot`). The count never exceeds `max`.
   */
  async acquireSlot(userId: string, max: number): Promise<string> {
    const key = `rt:conns:${userId}`;
    const now = Date.now();
    const id = randomUUID();
    // One atomic step: drop stale slots, make room at the cap, take a slot.
    await this.redis.eval(
      `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1] - ARGV[4])
       local over = redis.call('ZCARD', KEYS[1]) - tonumber(ARGV[2]) + 1
       if over > 0 then redis.call('ZPOPMIN', KEYS[1], over) end
       redis.call('ZADD', KEYS[1], ARGV[1], ARGV[3])
       redis.call('EXPIRE', KEYS[1], 3600)
       return 1`,
      1,
      key,
      now,
      Math.max(max, 1),
      id,
      CONNECTION_TTL_MS,
    );
    return id;
  }

  /** Keep a slot alive. False when the slot is gone (evicted or expired): the connection must end. */
  async refreshSlot(userId: string, slotId: string): Promise<boolean> {
    try {
      const kept = await this.redis.eval(
        `if redis.call('ZSCORE', KEYS[1], ARGV[2]) then
           redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
           return 1
         end
         return 0`,
        1,
        `rt:conns:${userId}`,
        Date.now(),
        slotId,
      );
      return kept === 1;
    } catch {
      // Redis hiccup: keep the connection, the next heartbeat tries again.
      return true;
    }
  }

  async releaseSlot(userId: string, slotId: string): Promise<void> {
    await this.redis.zrem(`rt:conns:${userId}`, slotId).catch(() => undefined);
  }

  /**
   * The frames of one connection. Ends when `signal` aborts. Throws if Redis is unreachable so
   * the controller can answer with an error frame instead of holding an empty stream open.
   */
  async *frames(userId: string, lastEventId: string | undefined, signal: AbortSignal, options: StreamOptions = {}): AsyncGenerator<SseFrame> {
    const heartbeatMs = options.heartbeatMs ?? 25_000;
    const key = streamKey(userId);
    const subscriber: Subscriber = { base: '0-0', queue: [] };
    const onAbort = (): void => subscriber.wake?.();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await this.join(key, subscriber);
      if (lastEventId !== undefined) {
        const verdict = await this.replayable(key, lastEventId);
        if (verdict === 'ok') {
          // Everything after the client's id up to where live delivery starts.
          const missed = await this.redis.xrange(key, `(${lastEventId}`, subscriber.base);
          for (const [id, fields] of missed) {
            yield { kind: 'event', id, envelope: this.toEnvelope(id, fields) };
          }
        } else {
          yield {
            kind: 'resync',
            envelope: { id: '', type: 'resync', occurredAt: new Date().toISOString(), data: { reason: verdict }, version: 1 },
          };
        }
      }

      while (!signal.aborted && !this.closing) {
        if (subscriber.failed) throw subscriber.failed;
        const next = subscriber.queue.shift();
        if (next) {
          yield next;
          continue;
        }
        const woken = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            subscriber.wake = undefined;
            resolve(false);
          }, heartbeatMs);
          subscriber.wake = () => {
            clearTimeout(timer);
            subscriber.wake = undefined;
            resolve(true);
          };
        });
        if (!woken && !signal.aborted && subscriber.queue.length === 0) yield { kind: 'heartbeat' };
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.leave(key, subscriber);
    }
  }

  /** Register a connection with the shared reader. Live delivery starts after `subscriber.base`. */
  private async join(key: string, subscriber: Subscriber): Promise<void> {
    let channel = this.channels.get(key);
    if (!channel) {
      const newest = await this.newestId(key);
      // Another connection may have registered the stream while we asked Redis.
      channel = this.channels.get(key);
      if (!channel) {
        channel = { cursor: newest, subscribers: new Set() };
        this.channels.set(key, channel);
      }
    }
    subscriber.base = channel.cursor;
    channel.subscribers.add(subscriber);
    if (!this.running) void this.run();
  }

  private leave(key: string, subscriber: Subscriber): void {
    const channel = this.channels.get(key);
    if (!channel) return;
    channel.subscribers.delete(subscriber);
    // The shared reader stops by itself once no stream is left.
    if (channel.subscribers.size === 0) this.channels.delete(key);
  }

  private push(subscriber: Subscriber, frame: SseFrame): void {
    if (subscriber.queue.length >= MAX_QUEUED_FRAMES) {
      subscriber.queue.length = 0;
      subscriber.queue.push({
        kind: 'resync',
        envelope: { id: '', type: 'resync', occurredAt: new Date().toISOString(), data: { reason: 'TOO_SLOW' }, version: 1 },
      });
    }
    subscriber.queue.push(frame);
    subscriber.wake?.();
  }

  /**
   * The one blocking read of this process: every open stream, fanned out to its connections.
   *
   * A Redis hiccup (a reset socket, a restart) is retried on a fresh connection and reading resumes
   * from each stream's cursor, so no event is lost and no browser has to reconnect. Only a Redis that
   * stays down tells the connections to give up.
   */
  private async run(): Promise<void> {
    this.running = true;
    let failures = 0;
    while (this.channels.size > 0 && !this.closing) {
      const reader = new Redis({
        ...redisOptionsFromUrl(this.config.getOrThrow<string>('redis.url')),
        maxRetriesPerRequest: 1,
      });
      reader.on('error', () => undefined);
      this.reader = reader;
      try {
        while (this.channels.size > 0 && !this.closing) {
          const keys = [...this.channels.keys()];
          const cursors = keys.map((key) => this.channels.get(key)!.cursor);
          // ioredis types xread for one key at a time; Redis takes a key list.
          const xread = reader.xread.bind(reader) as unknown as (...args: Array<string | number>) => Promise<XreadResult>;
          const result = await xread('BLOCK', HUB_BLOCK_MS, 'STREAMS', ...keys, ...cursors);
          failures = 0;
          if (!result) continue;
          for (const [key, entries] of result) {
            const channel = this.channels.get(key);
            if (!channel) continue;
            for (const [id, fields] of entries) {
              channel.cursor = id;
              const frame: SseFrame = { kind: 'event', id, envelope: this.toEnvelope(id, fields) };
              for (const subscriber of channel.subscribers) this.push(subscriber, frame);
            }
          }
        }
      } catch (error) {
        if (this.closing) break;
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Realtime reader failed (${failures}/${MAX_READER_FAILURES}): ${message}`);
        if (failures >= MAX_READER_FAILURES) {
          const failure = error instanceof Error ? error : new Error(message);
          for (const channel of this.channels.values()) {
            for (const subscriber of channel.subscribers) {
              subscriber.failed = failure;
              subscriber.wake?.();
            }
          }
          this.channels.clear();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(500 * failures, 3_000)));
      } finally {
        reader.disconnect();
        this.reader = undefined;
      }
    }
    this.running = false;
    // A stream registered while the reader was shutting down still needs one.
    if (this.channels.size > 0 && !this.closing) void this.run();
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

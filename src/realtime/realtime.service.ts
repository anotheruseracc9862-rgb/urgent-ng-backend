import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';

/** The envelope every realtime event carries (Backend PRD 19.5). */
export interface RealtimeEnvelope {
  /** The Redis stream entry id; also the SSE `id`, so `Last-Event-ID` resumes from it. */
  id: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
  version: 1;
}

export const STREAM_MAX_LEN = 1000;
export const STREAM_TTL_SECONDS = 24 * 3600;

export const streamKey = (userId: string): string => `rt:user:${userId}`;

/**
 * Per-user realtime streams in Redis (Backend PRD 19.5). SSE is a best-effort accelerator:
 * PostgreSQL stays authoritative, so a failed publish is logged and swallowed, never raised into
 * the business flow. Each user has one stream, capped at about 1000 entries and 24 hours.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Append an event to a user's stream. Returns the stream id, or null when Redis was not
   * available (the client then refetches on its next reconnect, which sends `resync`).
   */
  async publish(userId: string, type: string, data: Record<string, unknown>, occurredAt: Date = new Date()): Promise<string | null> {
    const key = streamKey(userId);
    try {
      const id = await this.redis.xadd(
        key,
        'MAXLEN',
        '~',
        STREAM_MAX_LEN,
        '*',
        'type',
        type,
        'occurredAt',
        occurredAt.toISOString(),
        'data',
        JSON.stringify(data),
      );
      await this.redis.expire(key, STREAM_TTL_SECONDS);
      return id;
    } catch (error) {
      this.logger.warn(`Realtime publish ${type} for ${userId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** A signed, short-lived ticket for clients that cannot send cookies (EventSource on mobile). */
  newTicketId(): string {
    return randomUUID();
  }
}

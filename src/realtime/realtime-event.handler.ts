import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../database/prisma.service.js';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { EventDispatcher, type DomainEvent, type DomainEventHandler } from '../queue/event-dispatcher.js';
import { RealtimeService } from './realtime.service.js';

/** Events that carry no one-to-one meaning for a client. */
const IGNORED_PREFIXES = ['media.', 'user.'];

/** Payload keys that name a participant of the event. */
const PARTICIPANT_KEYS = ['requesterId', 'runnerId', 'userId', 'recipientId', 'senderId'] as const;

/**
 * Writes every domain event to the streams of the users it concerns (Backend PRD 19.5): "a
 * dispatcher consumes outbox events and writes to the per-user stream". Best effort: the stream is
 * an accelerator, PostgreSQL is authoritative, and a client that missed an event refetches.
 *
 * Idempotent: a retried job does not write an entry twice (a short-lived `seen` key per event and
 * user).
 */
@Injectable()
export class RealtimeEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = 'RealtimeEventHandler';

  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly realtime: RealtimeService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: DomainEvent): Promise<void> {
    if (IGNORED_PREFIXES.some((prefix) => event.eventType.startsWith(prefix))) {
      return;
    }
    const users = await this.participants(event);
    if (users.size === 0) {
      return;
    }
    const data = this.publicData(event.payload);
    for (const userId of users) {
      if (!(await this.firstTime(event.eventId, userId))) {
        continue;
      }
      await this.realtime.publish(userId, event.eventType, data, new Date(event.occurredAt));
    }
  }

  /** The users this event concerns: named in the payload, plus the runner of the errand if it is not named. */
  private async participants(event: DomainEvent): Promise<Set<string>> {
    const users = new Set<string>();
    for (const key of PARTICIPANT_KEYS) {
      const value = event.payload[key];
      if (typeof value === 'string') users.add(value);
    }
    const errandId = event.payload.errandId;
    if (typeof errandId === 'string' && typeof event.payload.runnerId !== 'string') {
      const rows = await this.prisma.$queryRaw<Array<{ runner_id: string }>>`
        SELECT runner_id::text FROM assignments
        WHERE errand_id = ${errandId}::uuid AND deleted_at IS NULL
          AND status IN ('PENDING_ACCEPTANCE'::"AssignmentStatus", 'ACCEPTED'::"AssignmentStatus", 'COMPLETED'::"AssignmentStatus")
        ORDER BY created_at DESC LIMIT 1
      `;
      if (rows[0]) users.add(rows[0].runner_id);
    }
    return users;
  }

  /** Scalars only: ids, statuses, amounts. Nothing nested, nothing free-form from a user. */
  private publicData(payload: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        out[key] = value;
      }
    }
    return out;
  }

  private async firstTime(eventId: string, userId: string): Promise<boolean> {
    try {
      const set = await this.redis.set(`rt:seen:${eventId}:${userId}`, '1', 'EX', 3600, 'NX');
      return set === 'OK';
    } catch {
      return true;
    }
  }
}

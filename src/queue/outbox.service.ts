/**
 * Outbox service (P1-04)
 * Provides transactional outbox pattern for reliable event publishing
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { OutboxStatus, Prisma } from '@prisma/client';

/** How long a claimed event may stay PROCESSING before another publisher reclaims it. */
export const OUTBOX_LEASE_MS = 2 * 60 * 1000;
export const OUTBOX_MAX_ATTEMPTS = 10;

export type PublishFn = (event: OutboxEventRow) => Promise<void>;

export interface AddOutboxEventInput {
  eventType: string;
  aggregateType?: string;
  aggregateId?: string;
  payload: Record<string, unknown>;
  occurredAt?: Date;
  /**
   * Delay before the event becomes available for processing.
   * Useful for scheduled events or rate limiting.
   */
  delayMs?: number;
}

@Injectable()
export class OutboxService implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private publisherInterval?: NodeJS.Timeout;
  private isPublishing = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Add an outbox event within an existing transaction.
   * This is the primary method for adding outbox events from business logic.
   */
  async add(
    tx: Prisma.TransactionClient,
    input: AddOutboxEventInput,
  ): Promise<string> {
    return this.insert(tx, input);
  }

  /**
   * Add an outbox event outside of a transaction (for testing or special cases).
   * Prefer using add() with a transaction in production code.
   */
  async addStandalone(input: AddOutboxEventInput): Promise<string> {
    return this.insert(this.prisma, input);
  }

  /**
   * Insert using the database clock for "now" and for the delay, so
   * `available_at <= NOW()` in the publisher query is never affected by clock
   * differences between the API host and PostgreSQL.
   */
  private async insert(
    client: Prisma.TransactionClient,
    input: AddOutboxEventInput,
  ): Promise<string> {
    const delaySeconds = (input.delayMs ?? 0) / 1000;

    const rows = await client.$queryRaw<Array<{ id: string }>>`
      INSERT INTO outbox_events (
        event_type, aggregate_type, aggregate_id, payload, occurred_at, available_at
      )
      VALUES (
        ${input.eventType},
        ${input.aggregateType ?? null},
        ${input.aggregateId ?? null}::uuid,
        ${JSON.stringify(input.payload)}::jsonb,
        COALESCE(${input.occurredAt ?? null}::timestamptz, clock_timestamp()),
        clock_timestamp() + make_interval(secs => ${delaySeconds})
      )
      RETURNING id
    `;

    return rows[0].id;
  }

  /**
   * Start the publisher loop (called by the worker process).
   * Polls due events every second and hands each one to `publishFn`.
   */
  startPublisher(publishFn: PublishFn): void {
    if (this.publisherInterval) {
      this.logger.warn('Publisher already running');
      return;
    }

    this.logger.log('Starting outbox publisher');

    const run = async () => {
      if (this.isPublishing) {
        return; // previous run still in progress
      }

      this.isPublishing = true;
      try {
        await this.publishPendingEvents(publishFn);
      } catch (error) {
        this.logger.error('Publisher error', error);
      } finally {
        this.isPublishing = false;
      }
    };

    void run();
    this.publisherInterval = setInterval(run, 1000);
  }

  /**
   * Stop the publisher loop (cleanup)
   */
  stopPublisher(): void {
    if (this.publisherInterval) {
      clearInterval(this.publisherInterval);
      this.publisherInterval = undefined;
      this.logger.log('Stopped outbox publisher');
    }
  }

  /**
   * Claim one batch of due events and publish each one on its own, so one bad
   * event never blocks or re-sends the rest of the batch.
   *
   * A claim marks the row PROCESSING and stamps `processing_started_at`. A
   * row stuck in PROCESSING longer than the lease (crashed publisher) is
   * claimed again. Publishing must therefore be idempotent: the BullMQ job id
   * is the outbox id, so a repeat publish is a no-op.
   *
   * Returns the number of events published successfully.
   */
  async publishPendingEvents(publishFn: PublishFn): Promise<number> {
    const batch = await this.claimBatch();
    let published = 0;

    for (const event of batch) {
      try {
        await publishFn(event);
        await this.markPublished(event.id);
        published += 1;
      } catch (error) {
        this.logger.error(`Failed to publish event ${event.id}`, error);
        await this.handleFailedEvent(event, error);
      }
    }

    return published;
  }

  private async claimBatch(): Promise<OutboxEventRow[]> {
    const leaseSeconds = OUTBOX_LEASE_MS / 1000;

    return this.prisma.$transaction(async (tx) => {
      const events = await tx.$queryRaw<OutboxEventRow[]>`
        SELECT
          id,
          event_type AS "eventType",
          aggregate_type AS "aggregateType",
          aggregate_id AS "aggregateId",
          payload,
          occurred_at AS "occurredAt",
          attempts
        FROM outbox_events
        WHERE (
            status IN ('PENDING', 'FAILED')
            AND available_at <= NOW()
          )
          OR (
            status = 'PROCESSING'
            AND processing_started_at <= NOW() - make_interval(secs => ${leaseSeconds})
          )
        ORDER BY occurred_at, id
        LIMIT 100
        FOR UPDATE SKIP LOCKED
      `;

      if (events.length === 0) {
        return [];
      }

      const ids = events.map((event) => event.id);
      await tx.$executeRaw`
        UPDATE outbox_events
        SET status = 'PROCESSING'::"OutboxStatus",
            processing_started_at = NOW()
        WHERE id = ANY(${ids}::uuid[])
      `;

      return events;
    });
  }

  private async markPublished(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'PUBLISHED'::"OutboxStatus",
          processed_at = NOW(),
          processing_started_at = NULL,
          attempts = attempts + 1
      WHERE id = ${id}::uuid
    `;
  }

  /**
   * Failed events retry with exponential backoff, then dead-letter.
   */
  private async handleFailedEvent(
    event: OutboxEventRow,
    error: unknown,
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const attempts = event.attempts + 1;

    if (attempts >= OUTBOX_MAX_ATTEMPTS) {
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: OutboxStatus.DEAD_LETTERED,
          attempts,
          lastError: errorMessage,
          processedAt: new Date(),
          processingStartedAt: null,
        },
      });
      this.logger.error(`Event ${event.id} dead-lettered after ${attempts} attempts`);
      return;
    }

    // 1s, 2s, 4s ... capped at 5 minutes. The retry time comes from the database clock, the same
    // clock the publisher compares it with (`available_at <= NOW()`), so a server whose clock is
    // a little off retries on time instead of early or late.
    const backoffMs = Math.min(2 ** (attempts - 1) * 1000, 5 * 60 * 1000);
    await this.prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'FAILED'::"OutboxStatus",
          attempts = ${attempts},
          last_error = ${errorMessage},
          available_at = NOW() + make_interval(secs => ${backoffMs / 1000}::double precision),
          processing_started_at = NULL
      WHERE id = ${event.id}::uuid
    `;
    this.logger.warn(
      `Event ${event.id} failed (attempt ${attempts}), retry in ${backoffMs}ms`,
    );
  }

  /**
   * Retry a dead-lettered event (admin operation)
   */
  async retryDeadLettered(eventId: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: eventId, status: OutboxStatus.DEAD_LETTERED },
      data: {
        status: OutboxStatus.PENDING,
        attempts: 0,
        availableAt: new Date(),
        lastError: null,
      },
    });

    this.logger.log(`Retrying dead-lettered event ${eventId}`);
  }

  /**
   * Get dead-lettered events for admin monitoring
   */
  async getDeadLettered(limit = 100): Promise<OutboxEventRow[]> {
    return this.prisma.$queryRaw<OutboxEventRow[]>`
      SELECT 
        id,
        event_type as "eventType",
        aggregate_type as "aggregateType",
        aggregate_id as "aggregateId",
        payload,
        occurred_at as "occurredAt",
        attempts,
        last_error as "lastError",
        processed_at as "processedAt"
      FROM outbox_events
      WHERE status = 'DEAD_LETTERED'
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `;
  }

  onModuleDestroy() {
    this.stopPublisher();
  }
}

export interface OutboxEventRow {
  id: string;
  eventType: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: unknown;
  occurredAt: Date;
  attempts: number;
  lastError?: string | null;
  processedAt?: Date | null;
}

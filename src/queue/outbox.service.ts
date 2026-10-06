/**
 * Outbox service (P1-04)
 * Provides transactional outbox pattern for reliable event publishing
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { OutboxStatus, Prisma } from '@prisma/client';

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
    const now = new Date();
    const availableAt = input.delayMs
      ? new Date(now.getTime() + input.delayMs)
      : now;

    const event = await tx.outboxEvent.create({
      data: {
        eventType: input.eventType,
        aggregateType: input.aggregateType || null,
        aggregateId: input.aggregateId || null,
        payload: input.payload as Prisma.JsonObject,
        occurredAt: input.occurredAt || now,
        availableAt,
      },
    });

    return event.id;
  }

  /**
   * Add an outbox event outside of a transaction (for testing or special cases).
   * Prefer using add() with a transaction in production code.
   */
  async addStandalone(input: AddOutboxEventInput): Promise<string> {
    const now = new Date();
    const availableAt = input.delayMs
      ? new Date(now.getTime() + input.delayMs)
      : now;

    const event = await this.prisma.outboxEvent.create({
      data: {
        eventType: input.eventType,
        aggregateType: input.aggregateType || null,
        aggregateId: input.aggregateId || null,
        payload: input.payload as Prisma.JsonObject,
        occurredAt: input.occurredAt || now,
        availableAt,
      },
    });

    return event.id;
  }

  /**
   * Start the publisher loop (called by the worker/scheduler process).
   * Polls pending events every 1 second and publishes them to BullMQ.
   */
  startPublisher(publishFn: (events: OutboxEventBatch[]) => Promise<void>): void {
    if (this.publisherInterval) {
      this.logger.warn('Publisher already running');
      return;
    }

    this.logger.log('Starting outbox publisher');

    const runPublisher = async () => {
      if (this.isPublishing) {
        return; // Skip if previous run still in progress
      }

      this.isPublishing = true;
      try {
        await this.publishPendingEvents(publishFn);
      } catch (error) {
        this.logger.error('Publisher error:', error);
      } finally {
        this.isPublishing = false;
      }
    };

    // Run immediately on start
    runPublisher();

    // Then run every 1 second
    this.publisherInterval = setInterval(runPublisher, 1000);
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
   * Poll for pending events and publish them.
   * Uses FOR UPDATE SKIP LOCKED to prevent duplicate processing.
   */
  private async publishPendingEvents(
    publishFn: (events: OutboxEventBatch[]) => Promise<void>,
  ): Promise<void> {
    const batch = await this.prisma.$transaction(async (tx) => {
      // Lock pending events with SKIP LOCKED for concurrent safety
      const events = await tx.$queryRaw<OutboxEventRow[]>`
        SELECT 
          id,
          event_type as "eventType",
          aggregate_type as "aggregateType",
          aggregate_id as "aggregateId",
          payload,
          occurred_at as "occurredAt",
          attempts
        FROM outbox_events
        WHERE status IN ('PENDING', 'FAILED')
          AND available_at <= NOW()
        ORDER BY occurred_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 100
      `;

      if (events.length === 0) {
        return [];
      }

      // Mark events as PROCESSING
      const eventIds = events.map((e) => e.id);
      await tx.$executeRaw`
        UPDATE outbox_events
        SET status = 'PROCESSING'::' OutboxStatus'
        WHERE id = ANY(${eventIds}::uuid[])
      `;

      return events;
    });

    if (batch.length === 0) {
      return;
    }

    this.logger.debug(`Publishing ${batch.length} outbox events`);

    // Publish to BullMQ
    try {
      await publishFn(batch);

      // Mark as published
      const eventIds = batch.map((e) => e.id);
      await this.prisma.$executeRaw`
        UPDATE outbox_events
        SET 
          status = 'PUBLISHED'::"OutboxStatus",
          processed_at = NOW(),
          attempts = attempts + 1
        WHERE id = ANY(${eventIds}::uuid[])
      `;
    } catch (error) {
      this.logger.error('Failed to publish batch:', error);

      // Handle failures with exponential backoff
      await this.handleFailedBatch(batch, error);
    }
  }

  /**
   * Handle failed events with exponential backoff and dead-lettering
   */
  private async handleFailedBatch(
    batch: OutboxEventRow[],
    error: unknown,
  ): Promise<void> {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    for (const event of batch) {
      const newAttempts = event.attempts + 1;

      if (newAttempts >= 10) {
        // Dead letter after 10 attempts
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: OutboxStatus.DEAD_LETTERED,
            attempts: newAttempts,
            lastError: errorMessage,
            processedAt: new Date(),
          },
        });

        this.logger.error(
          `Event ${event.id} dead-lettered after ${newAttempts} attempts`,
        );
      } else {
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, up to 5 minutes
        const backoffMs = Math.min(
          Math.pow(2, newAttempts - 1) * 1000,
          5 * 60 * 1000,
        );
        const availableAt = new Date(Date.now() + backoffMs);

        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: OutboxStatus.FAILED,
            attempts: newAttempts,
            lastError: errorMessage,
            availableAt,
          },
        });

        this.logger.warn(
          `Event ${event.id} failed (attempt ${newAttempts}), retry in ${backoffMs}ms`,
        );
      }
    }
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

export type OutboxEventBatch = OutboxEventRow;

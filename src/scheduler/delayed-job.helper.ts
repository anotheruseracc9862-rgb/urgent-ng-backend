import { Injectable } from '@nestjs/common';
import { OutboxService } from '../queue/outbox.service.js';

/**
 * Helper for scheduling delayed jobs via the outbox.
 * Accelerators (e.g., Pro runner head start) use this to publish events at a future time.
 * Per PRD §12.5 and §25.3.
 */
@Injectable()
export class DelayedJobHelper {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Schedule a job to run after a delay.
   * The event is published to the outbox with delayMs.
   * 
   * @param eventType - Event type to publish
   * @param payload - Event payload
   * @param delayMs - Delay in milliseconds from now
   * @param aggregateType - Optional aggregate type for partitioning
   * @param aggregateId - Optional aggregate ID for partitioning
   */
  async schedule(
    eventType: string,
    payload: Record<string, unknown>,
    delayMs: number,
    aggregateType?: string,
    aggregateId?: string,
  ): Promise<string> {
    return this.outbox.addStandalone({
      eventType,
      payload,
      aggregateType,
      aggregateId,
      delayMs,
    });
  }

  /**
   * Schedule a job to run at a specific time.
   * 
   * @param eventType - Event type to publish
   * @param payload - Event payload
   * @param runAt - Exact time to run the job
   * @param aggregateType - Optional aggregate type for partitioning
   * @param aggregateId - Optional aggregate ID for partitioning
   */
  async scheduleAt(
    eventType: string,
    payload: Record<string, unknown>,
    runAt: Date,
    aggregateType?: string,
    aggregateId?: string,
  ): Promise<string> {
    const delayMs = Math.max(0, runAt.getTime() - Date.now());
    
    return this.outbox.addStandalone({
      eventType,
      payload,
      aggregateType,
      aggregateId,
      delayMs,
    });
  }
}

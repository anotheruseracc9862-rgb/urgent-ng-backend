/**
 * Base consumer class (P1-04)
 * Provides idempotent job processing pattern
 */

import { Logger } from '@nestjs/common';

export interface JobContext<T = unknown> {
  id: string;
  data: T;
  attemptsMade: number;
}

/**
 * Base class for idempotent queue consumers.
 * 
 * Guidelines:
 * - Every process() implementation must re-read authoritative state in a transaction
 * - Check if the work is already done before doing it
 * - Return success even if the entity has moved on (idempotency)
 * - Throw only for transient errors that should be retried
 */
export abstract class BaseConsumer<T = unknown> {
  protected readonly logger: Logger;

  constructor(
    protected readonly consumerName: string,
  ) {
    this.logger = new Logger(consumerName);
  }

  /**
   * Process a job. Must be idempotent.
   * 
   * - Return void for success
   * - Throw for transient errors that should be retried
   * - Log but don't throw for entity-moved-on cases (these are success)
   */
  abstract process(context: JobContext<T>): Promise<void>;

  /**
   * Wrapper that adds logging and error handling
   */
  async handle(context: JobContext<T>): Promise<void> {
    this.logger.debug(
      `Processing job ${context.id} (attempt ${context.attemptsMade + 1})`,
    );

    try {
      await this.process(context);
      this.logger.debug(`Job ${context.id} completed successfully`);
    } catch (error) {
      this.logger.error(
        `Job ${context.id} failed (attempt ${context.attemptsMade + 1}):`,
        error,
      );
      throw error; // Re-throw for BullMQ retry logic
    }
  }

  /**
   * Helper to check if a timestamp has passed (with server time)
   */
  protected hasDeadlinePassed(deadline: Date): boolean {
    return new Date() > deadline;
  }

  /**
   * Helper to safely extract error message
   */
  protected getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

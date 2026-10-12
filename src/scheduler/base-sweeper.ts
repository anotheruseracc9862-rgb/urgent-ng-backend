import { Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

/**
 * Base class for sweeper jobs that process due rows.
 * Per PRD §25.3: query with FOR UPDATE SKIP LOCKED, process in batches.
 * 
 * Usage:
 * ```typescript
 * class ErrandExpirySweeper extends BaseSweeper {
 *   async processBatch() {
 *     const dueErrands = await this.prisma.$queryRaw`
 *       SELECT id FROM errands
 *       WHERE status = 'OPEN' AND expires_at <= now()
 *       FOR UPDATE SKIP LOCKED
 *       LIMIT 100
 *     `;
 *     
 *     for (const row of dueErrands) {
 *       await this.processOne(row.id);
 *     }
 *   }
 *   
 *   async processOne(id: string) {
 *     // Move errand to EXPIRED
 *   }
 * }
 * ```
 */
export abstract class BaseSweeper {
  protected readonly logger: Logger;
  
  /**
   * Interval in milliseconds between sweeps.
   * Defaults to 60 seconds per PRD §25.3.
   */
  protected readonly intervalMs: number = 60000;
  
  /**
   * Whether this sweeper is currently running.
   */
  private running = false;

  /**
   * True while a sweep is in progress, so a slow sweep is never overlapped by
   * the next tick of the same sweeper.
   */
  private sweeping = false;
  
  /**
   * Interval handle for stopping.
   */
  private intervalHandle?: NodeJS.Timeout;

  private readonly sweeperName: string;

  constructor(
    protected readonly prisma: PrismaService,
    loggerName: string,
  ) {
    this.logger = new Logger(loggerName);
    this.sweeperName = loggerName;
  }

  /**
   * Start the sweeper loop.
   * Safe to call multiple times - only one loop will run.
   */
  start(): void {
    if (this.running) {
      this.logger.warn('Sweeper already running');
      return;
    }

    this.running = true;
    this.logger.log(`Starting sweeper (interval: ${this.intervalMs}ms)`);

    // Run immediately, then on interval
    this.sweep().catch((error) => {
      this.logger.error('Initial sweep failed', error);
    });

    this.intervalHandle = setInterval(() => {
      this.sweep().catch((error) => {
        this.logger.error('Sweep failed', error);
      });
    }, this.intervalMs);
  }

  /**
   * Stop the sweeper loop.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }

    this.logger.log('Sweeper stopped');
  }

  /**
   * Run one sweep cycle.
   * Catches and logs errors to prevent the loop from dying.
   */
  private async sweep(): Promise<void> {
    if (!this.running || this.sweeping) {
      return;
    }

    this.sweeping = true;
    const startedAt = new Date();
    const startTime = Date.now();
    let processed = 0;
    let failure: string | null = null;
    try {
      processed = await this.processBatch();
      const duration = Date.now() - startTime;

      if (processed > 0) {
        this.logger.log(`Processed ${processed} rows in ${duration}ms`);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      this.logger.error('Sweep error', error);
    } finally {
      this.sweeping = false;
      await this.recordRun(startedAt, Date.now() - startTime, processed, failure);
    }
  }

  /** Leave a heartbeat the admin console can show. Best effort: a failure here never stops the sweeper. */
  private async recordRun(startedAt: Date, durationMs: number, processed: number, failure: string | null): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO sweeper_runs (name, last_started_at, last_finished_at, last_duration_ms, last_processed, last_error, last_error_at, runs, failures, updated_at)
        VALUES (${this.sweeperName}, ${startedAt}::timestamptz, clock_timestamp(), ${durationMs}::int, ${processed}::int,
                ${failure?.slice(0, 500) ?? null}, ${failure ? new Date() : null}::timestamptz, 1, ${failure ? 1 : 0}, clock_timestamp())
        ON CONFLICT (name) DO UPDATE SET
          last_started_at = EXCLUDED.last_started_at, last_finished_at = EXCLUDED.last_finished_at,
          last_duration_ms = EXCLUDED.last_duration_ms, last_processed = EXCLUDED.last_processed,
          last_error = COALESCE(EXCLUDED.last_error, sweeper_runs.last_error),
          last_error_at = COALESCE(EXCLUDED.last_error_at, sweeper_runs.last_error_at),
          runs = sweeper_runs.runs + 1, failures = sweeper_runs.failures + ${failure ? 1 : 0},
          updated_at = clock_timestamp()
      `;
    } catch {
      // The heartbeat is a convenience.
    }
  }

  /**
   * Process a batch of due rows.
   * Returns the number of rows processed.
   * 
   * Implementation must:
   * 1. Query with FOR UPDATE SKIP LOCKED LIMIT 100
   * 2. Process each row (ideally in a transaction)
   * 3. Return the count
   */
  protected abstract processBatch(): Promise<number>;
}

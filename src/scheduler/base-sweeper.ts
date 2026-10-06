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
   * Interval handle for stopping.
   */
  private intervalHandle?: NodeJS.Timeout;

  constructor(
    protected readonly prisma: PrismaService,
    loggerName: string,
  ) {
    this.logger = new Logger(loggerName);
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
    if (!this.running) {
      return;
    }

    try {
      const startTime = Date.now();
      const processed = await this.processBatch();
      const duration = Date.now() - startTime;

      if (processed > 0) {
        this.logger.log(`Processed ${processed} rows in ${duration}ms`);
      }
    } catch (error) {
      this.logger.error('Sweep error', error);
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

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { ErrandStateService } from './errand-state.service.js';

const BATCH = 100;

/**
 * Moves OPEN errands past `expires_at` to EXPIRED (Backend PRD 11.4). The deadline is a database
 * fact: every comparison uses the database clock, and the queue is only an accelerator.
 *
 * Two entry points: the scheduler's sweeper (`expireDue`) and a lazy check on reads
 * (`expireIfDue`), so a requester never sees an open errand whose time has already passed.
 * The `errand.expired` event is what closes the offers (Phase 6) and tells the requester.
 */
@Injectable()
export class ErrandExpiryService {
  private readonly logger = new Logger(ErrandExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ErrandStateService,
  ) {}

  /** Expire up to `limit` due errands. Returns how many were expired. */
  async expireDue(limit = BATCH): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM errands
      WHERE status = 'OPEN'::"ErrandStatus" AND deleted_at IS NULL AND expires_at <= clock_timestamp()
      ORDER BY expires_at
      LIMIT ${limit}
    `;
    let expired = 0;
    for (const { id } of due) {
      if (await this.expireIfDue(id)) expired += 1;
    }
    return expired;
  }

  /** Expire this errand if it is OPEN and past its deadline. Returns true when it was expired. */
  async expireIfDue(errandId: string): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Re-check under the row lock: it may have been selected, cancelled or extended since.
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text FROM errands
          WHERE id = ${errandId}::uuid AND status = 'OPEN'::"ErrandStatus" AND deleted_at IS NULL
            AND expires_at <= clock_timestamp()
          FOR UPDATE SKIP LOCKED
        `;
        if (rows.length === 0) return false;
        await this.state.transition(tx, {
          errandId,
          to: 'EXPIRED',
          expectedFrom: 'OPEN',
          actor: { type: 'SYSTEM' },
          reason: 'No runner was selected before the deadline.',
        });
        return true;
      });
    } catch (error) {
      this.logger.error(`Could not expire errand ${errandId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

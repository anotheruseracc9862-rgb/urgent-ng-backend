import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { DELETION_BLOCKERS, type DeletionBlocker } from '../auth/account.service.js';

/**
 * Account deletion is blocked while the user still has an errand in flight or a live assignment
 * (Backend PRD 9.5, 36.8). Drafts, completed, cancelled and expired errands do not block. Reports
 * and disputes add their own blockers in Phase 9, unsettled platform orders in Phase 10.
 */
@Injectable()
export class ErrandDeletionBlocker implements DeletionBlocker, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DELETION_BLOCKERS) private readonly blockers: DeletionBlocker[],
  ) {}

  onModuleInit(): void {
    this.blockers.push(this);
  }

  async check(userId: string): Promise<Array<{ code: string; message: string }>> {
    const [errands, assignments] = await Promise.all([
      this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM errands
        WHERE requester_id = ${userId}::uuid AND deleted_at IS NULL
          AND status IN ('OPEN'::"ErrandStatus", 'RUNNER_SELECTED'::"ErrandStatus", 'ACCEPTED'::"ErrandStatus",
                         'IN_PROGRESS'::"ErrandStatus", 'PICKED_UP'::"ErrandStatus", 'DELIVERED'::"ErrandStatus",
                         'DISPUTED'::"ErrandStatus")
      `,
      this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM assignments
        WHERE runner_id = ${userId}::uuid AND deleted_at IS NULL
          AND status IN ('PENDING_ACCEPTANCE'::"AssignmentStatus", 'ACCEPTED'::"AssignmentStatus")
      `,
    ]);
    const reasons: Array<{ code: string; message: string }> = [];
    if (errands[0].n > 0) {
      reasons.push({ code: 'ACTIVE_ERRAND', message: 'You have an errand that is still open or in progress. Cancel it or let it finish first.' });
    }
    if (assignments[0].n > 0) {
      reasons.push({ code: 'ACTIVE_ASSIGNMENT', message: 'You have an errand assigned to you. Finish it or cancel it first.' });
    }
    return reasons;
  }
}

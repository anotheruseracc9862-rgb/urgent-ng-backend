import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { DELETION_BLOCKERS, type DeletionBlocker } from '../auth/account.service.js';

/**
 * Account deletion is blocked while a report or dispute involving the user is open (Backend PRD
 * 9.5, 36.8). The evidence is never erased; the account is anonymised only after the case closes.
 */
@Injectable()
export class CaseDeletionBlocker implements DeletionBlocker, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DELETION_BLOCKERS) private readonly blockers: DeletionBlocker[],
  ) {}

  onModuleInit(): void {
    this.blockers.push(this);
  }

  async check(userId: string): Promise<Array<{ code: string; message: string }>> {
    const [disputes, reports] = await Promise.all([
      this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM disputes d JOIN assignments a ON a.id = d.assignment_id
        WHERE d.deleted_at IS NULL AND d.status IN ('OPEN'::"DisputeStatus", 'UNDER_REVIEW'::"DisputeStatus")
          AND (a.requester_id = ${userId}::uuid OR a.runner_id = ${userId}::uuid)
      `,
      this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM reports
        WHERE deleted_at IS NULL
          AND status IN ('OPEN'::"ReportStatus", 'UNDER_REVIEW'::"ReportStatus", 'ACTION_REQUIRED'::"ReportStatus")
          AND (reporter_id = ${userId}::uuid OR target_user_id = ${userId}::uuid)
      `,
    ]);
    const reasons: Array<{ code: string; message: string }> = [];
    if (disputes[0].n > 0) {
      reasons.push({ code: 'OPEN_DISPUTE', message: 'You have a dispute that is still open. It must be decided first.' });
    }
    if (reports[0].n > 0) {
      reasons.push({ code: 'OPEN_REPORT', message: 'A report involving you is still open. It must be decided first.' });
    }
    return reasons;
  }
}

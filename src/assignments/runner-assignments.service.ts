import { Injectable } from '@nestjs/common';
import type { AssignmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import type { RunnerAssignmentSummaryDto, RunnerAssignmentsQueryDto } from './runner-assignments.dto.js';

const GROUPS: Record<'ACTIVE' | 'PAST', AssignmentStatus[]> = {
  ACTIVE: ['PENDING_ACCEPTANCE', 'ACCEPTED'],
  PAST: ['DECLINED', 'TIMED_OUT', 'CANCELLED', 'COMPLETED'],
};

/** The runner's own assignments, newest first (Backend PRD 30.2). Areas only; exact data is on GET /assignments/:id. */
@Injectable()
export class RunnerAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cursors: CursorService,
  ) {}

  async list(runnerId: string, options: Pick<RunnerAssignmentsQueryDto, 'status' | 'cursor' | 'limit'>): Promise<Paginated<RunnerAssignmentSummaryDto>> {
    const limit = options.limit ?? 20;
    const cursor = options.cursor ? this.cursors.decode(options.cursor) : undefined;
    const statuses =
      options.status === 'ACTIVE' || options.status === 'PAST' ? GROUPS[options.status] : options.status ? [options.status as AssignmentStatus] : undefined;
    const where: Prisma.AssignmentWhereInput = {
      runnerId,
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt as Date } },
              { createdAt: cursor.createdAt as Date, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.client.assignment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        errand: { select: { title: true, status: true, locations: { where: { deletedAt: null }, select: { type: true, area: true } } } },
      },
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return new Paginated(
      page.map((row) => ({
        id: row.id,
        errandId: row.errandId,
        status: row.status,
        errandStatus: row.errand.status,
        errandTitle: row.errand.title,
        agreedAmountMinor: Number(row.agreedAmountMinor),
        acceptanceDeadline: row.acceptanceDeadline,
        acceptedAt: row.acceptedAt,
        pickupArea: row.errand.locations.find((l) => l.type === 'ERRAND_PICKUP')?.area ?? null,
        destinationArea: row.errand.locations.find((l) => l.type === 'ERRAND_DESTINATION')?.area ?? null,
        selectedAt: row.selectedAt,
      })),
      {
        hasNextPage,
        ...(hasNextPage && last ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) } : {}),
      },
    );
  }
}

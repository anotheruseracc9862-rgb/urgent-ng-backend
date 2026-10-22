import { Injectable } from '@nestjs/common';
import type { AssignmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import type {
  HistorySummaryDto,
  RunnerAssignmentSummaryDto,
  RunnerAssignmentsQueryDto,
  RunnerHistoryExportQueryDto,
} from './runner-assignments.dto.js';

const EXPORT_LIMIT = 5000;

type Filters = Pick<RunnerAssignmentsQueryDto, 'status' | 'q' | 'from' | 'to'>;

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

  async list(runnerId: string, options: Filters & Pick<RunnerAssignmentsQueryDto, 'cursor' | 'limit'>): Promise<Paginated<RunnerAssignmentSummaryDto>> {
    const limit = options.limit ?? 20;
    const cursor = options.cursor ? this.cursors.decode(options.cursor) : undefined;
    const where: Prisma.AssignmentWhereInput = {
      ...this.filterWhere(runnerId, options),
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
        errand: { select: { title: true, status: true, category: { select: { flow: true } }, locations: { where: { deletedAt: null }, select: { type: true, area: true } } } },
        requester: { select: { firstName: true } },
      },
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    // One conversation per offer; the runner is always a participant of their own.
    const conversations = page.length
      ? await this.prisma.client.conversation.findMany({
          where: { offerId: { in: page.map((row) => row.selectedOfferId) }, runnerId, deletedAt: null },
          select: { id: true, offerId: true },
        })
      : [];
    const points = await this.approxPoints(page.map((row) => row.errandId));
    const conversationByOffer = new Map(conversations.map((conversation) => [conversation.offerId, conversation.id]));

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
        pickupApprox: points.get(`${row.errandId}:ERRAND_PICKUP`) ?? null,
        destinationApprox: points.get(`${row.errandId}:ERRAND_DESTINATION`) ?? null,
        categoryFlow: row.errand.category.flow,
        selectedAt: row.selectedAt,
        requesterFirstName: row.requester.firstName,
        conversationId: conversationByOffer.get(row.selectedOfferId) ?? null,
      })),
      {
        hasNextPage,
        ...(hasNextPage && last ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) } : {}),
      },
    );
  }

  /** The approximate points of the errands on a page, keyed `errandId:TYPE`. The exact point is never read here. */
  private async approxPoints(errandIds: string[]): Promise<Map<string, { lat: number; lng: number }>> {
    if (errandIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ errand_id: string; type: string; lat: number; lng: number }>>`
      SELECT errand_id::text, type::text AS type, ST_Y(approx_point::geometry) AS lat, ST_X(approx_point::geometry) AS lng
      FROM errand_locations
      WHERE errand_id = ANY(${errandIds}::uuid[]) AND deleted_at IS NULL
    `;
    return new Map(rows.map((row) => [`${row.errand_id}:${row.type}`, { lat: row.lat, lng: row.lng }]));
  }

  /**
   * Counts per month for the history chart, in Lagos time, for the last `months` months including
   * this one. Months with nothing in them are present with zeros, so a chart has no gaps.
   */
  async summary(runnerId: string, months = 12): Promise<HistorySummaryDto> {
    const rows = await this.prisma.$queryRaw<
      Array<{ month: string; completed: number; cancelled: number; not_accepted: number; agreed_total: bigint }>
    >`
      WITH span AS (
        SELECT to_char(m, 'YYYY-MM') AS month, m AS start_at
        FROM generate_series(
          date_trunc('month', (now() AT TIME ZONE 'Africa/Lagos')) - make_interval(months => ${months - 1}::int),
          date_trunc('month', (now() AT TIME ZONE 'Africa/Lagos')),
          interval '1 month'
        ) AS m
      )
      SELECT s.month,
             count(a.id) FILTER (WHERE a.status = 'COMPLETED'::"AssignmentStatus")::int AS completed,
             count(a.id) FILTER (WHERE a.status = 'CANCELLED'::"AssignmentStatus")::int AS cancelled,
             count(a.id) FILTER (WHERE a.status IN ('DECLINED'::"AssignmentStatus", 'TIMED_OUT'::"AssignmentStatus"))::int AS not_accepted,
             COALESCE(sum(a.agreed_amount_minor) FILTER (WHERE a.status = 'COMPLETED'::"AssignmentStatus"), 0)::bigint AS agreed_total
      FROM span s
      LEFT JOIN assignments a
        ON a.runner_id = ${runnerId}::uuid AND a.deleted_at IS NULL
       AND to_char(a.selected_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM') = s.month
      GROUP BY s.month
      ORDER BY s.month
    `;
    const out = rows.map((r) => ({
      month: r.month,
      completed: r.completed,
      cancelled: r.cancelled,
      notAccepted: r.not_accepted,
      agreedTotalMinor: Number(r.agreed_total),
    }));
    const completed = out.reduce((n, m) => n + m.completed, 0);
    const total = out.reduce((n, m) => n + m.completed + m.cancelled + m.notAccepted, 0);
    return { months: out, completed, total };
  }

  /**
   * The history as CSV, newest first, with the same filters as the list. Cells that a spreadsheet
   * could read as a formula are prefixed, so exported text never runs as one.
   */
  async exportCsv(runnerId: string, options: RunnerHistoryExportQueryDto): Promise<string> {
    const rows = await this.prisma.client.assignment.findMany({
      where: this.filterWhere(runnerId, options),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: EXPORT_LIMIT,
      include: {
        errand: { select: { title: true, status: true } },
        requester: { select: { firstName: true, lastName: true } },
        ratings: {
          where: { direction: 'REQUESTER_TO_RUNNER', status: 'PUBLISHED', revealedAt: { not: null }, deletedAt: null },
          select: { scores: { where: { dimension: 'OVERALL' }, select: { score: true } } },
        },
      },
    });
    const header = ['Errand', 'Requester', 'Selected on', 'Status', 'Rating', 'Agreed amount (NGN)'];
    const lines = [header.map(csvCell).join(',')];
    for (const row of rows) {
      const rating = row.ratings[0]?.scores[0]?.score;
      lines.push(
        [
          row.errand.title,
          `${row.requester.firstName} ${row.requester.lastName.charAt(0)}.`,
          row.selectedAt.toISOString().slice(0, 10),
          row.status,
          rating === undefined ? '' : String(rating),
          (Number(row.agreedAmountMinor) / 100).toFixed(2),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return lines.join('\r\n') + '\r\n';
  }

  private filterWhere(runnerId: string, filters: Filters): Prisma.AssignmentWhereInput {
    const statuses =
      filters.status === 'ACTIVE' || filters.status === 'PAST'
        ? GROUPS[filters.status]
        : filters.status
          ? [filters.status as AssignmentStatus]
          : undefined;
    const term = filters.q?.trim();
    return {
      runnerId,
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(filters.from || filters.to
        ? { selectedAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lt: filters.to } : {}) } }
        : {}),
      ...(term
        ? {
            OR: [
              { errand: { title: { contains: term, mode: 'insensitive' as const } } },
              { requester: { firstName: { contains: term, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };
  }
}

/** One CSV cell: quoted, with quotes doubled, and a leading quote against formula injection. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

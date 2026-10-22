import { findLiveBoosts } from '../boosts/live-boost.js';
import { Injectable } from '@nestjs/common';
import { Prisma, type ErrandStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { ErrandExpiryService } from './errand-expiry.service.js';
import { toNumber } from './errand-view.service.js';
import type { ErrandAttention, ErrandSummaryDto, MineCountsDto, MineSort, MineTab } from './errand.dto.js';

const TAB_STATUSES: Record<Exclude<MineTab, 'ATTENTION'>, ErrandStatus[]> = {
  DRAFT: ['DRAFT'],
  OPEN: ['OPEN'],
  ACTIVE: ['RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED', 'DISPUTED'],
  PAST: ['COMPLETED', 'CANCELLED', 'EXPIRED'],
};

/** Errands that need the requester next. Alias `e` is the errand. */
const ATTENTION_SQL = Prisma.sql`(
  e.status IN ('DELIVERED'::"ErrandStatus", 'RUNNER_SELECTED'::"ErrandStatus")
  OR (e.status = 'OPEN'::"ErrandStatus" AND (e.offer_count > 0 OR e.expires_at <= now() + interval '2 hours'))
  OR EXISTS (
    SELECT 1 FROM change_requests c JOIN assignments a ON a.id = c.assignment_id
    WHERE a.errand_id = e.id AND a.deleted_at IS NULL AND c.deleted_at IS NULL
      AND c.status = 'PENDING'::"ChangeRequestStatus" AND c.requested_by <> e.requester_id AND c.expires_at > now()
  )
)`;

const EXPIRING_WINDOW_HOURS = 2;

/** The requester's own list of errands, for the dashboard tabs (Backend PRD 30.4). */
@Injectable()
export class ErrandQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cursors: CursorService,
    private readonly expiry: ErrandExpiryService,
  ) {}

  async mine(
    userId: string,
    options: { tab?: MineTab; sort?: MineSort; q?: string; cursor?: string; limit?: number },
  ): Promise<Paginated<ErrandSummaryDto>> {
    const limit = options.limit ?? 20;
    const sort: MineSort = options.sort ?? 'RECENT';
    // Close this requester's overdue errands first, so the OPEN tab never shows one whose time has passed.
    await this.expireOverdue(userId);

    // The sort key, the tie-break time and the id make a total order, so a cursor never skips or repeats.
    const sortKey =
      sort === 'HIGHEST_AMOUNT'
        ? Prisma.sql`COALESCE(e.suggested_budget_minor, -1)::double precision`
        : sort === 'NEEDS_ATTENTION'
          ? Prisma.sql`(CASE
              WHEN e.status = 'DELIVERED' THEN 3
              WHEN e.status = 'RUNNER_SELECTED' THEN 2
              WHEN e.status = 'OPEN' AND e.offer_count > 0 THEN 2
              WHEN e.status IN ('ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DISPUTED') THEN 1
              ELSE 0 END)::double precision`
          : Prisma.sql`0::double precision`;
    // "Recent" means last activity (an edit, a new offer, a status change), not when the errand was created.
    const timeColumn = sort === 'HIGHEST_AMOUNT' ? Prisma.sql`e.created_at` : Prisma.sql`e.updated_at`;

    const conditions: Prisma.Sql[] = [Prisma.sql`e.requester_id = ${userId}::uuid`, Prisma.sql`e.deleted_at IS NULL`];
    if (options.tab === 'ATTENTION') {
      conditions.push(ATTENTION_SQL);
    } else if (options.tab) {
      conditions.push(Prisma.sql`e.status::text = ANY(${TAB_STATUSES[options.tab] as string[]}::text[])`);
    }
    const term = options.q?.trim();
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(Prisma.sql`(
        e.title ILIKE ${like}
        OR e.description ILIKE ${like}
        OR EXISTS (
          SELECT 1 FROM assignments a JOIN users u ON u.id = a.runner_id
          WHERE a.errand_id = e.id AND a.deleted_at IS NULL AND (u.first_name ILIKE ${like} OR u.name ILIKE ${like})
        )
      )`);
    }
    if (options.cursor) {
      const c = this.cursors.decode(options.cursor);
      conditions.push(
        Prisma.sql`(${sortKey}, ${timeColumn}, e.id) < (${Number(c.sort)}::double precision, ${c.createdAt as Date}::timestamptz, ${c.id}::uuid)`,
      );
    }

    const keys = await this.prisma.$queryRaw<Array<{ id: string; sort_key: number; ts: Date }>>`
      SELECT e.id::text AS id, ${sortKey} AS sort_key, ${timeColumn} AS ts
      FROM errands e
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY sort_key DESC, ts DESC, e.id DESC
      LIMIT ${limit + 1}
    `;
    const hasNextPage = keys.length > limit;
    const pageKeys = hasNextPage ? keys.slice(0, limit) : keys;
    const last = pageKeys[pageKeys.length - 1];

    const found = await this.prisma.client.errand.findMany({
      where: { id: { in: pageKeys.map((k) => k.id) } },
      include: { category: true, locations: { where: { deletedAt: null }, select: { type: true, area: true } } },
    });
    const byId = new Map(found.map((errand) => [errand.id, errand]));
    const page = pageKeys.map((k) => byId.get(k.id)).filter((errand): errand is NonNullable<typeof errand> => Boolean(errand));
    const points = await this.approxPoints(page.map((errand) => errand.id));
    const boosts = await findLiveBoosts(this.prisma, page.map((errand) => errand.id));
    const extras = await this.extras(userId, page.map((errand) => ({ id: errand.id, status: errand.status, offerCount: errand.offerCount, expiresAt: errand.expiresAt })));

    return new Paginated(
      page.map((errand) => ({
        ...extras.get(errand.id)!,
        id: errand.id,
        status: errand.status,
        title: errand.title,
        category: { id: errand.category.id, key: errand.category.key, name: errand.category.name, flow: errand.category.flow },
        priority: errand.priority,
        timeMode: errand.timeMode,
        scheduledAt: errand.scheduledAt,
        suggestedBudgetMinor: toNumber(errand.suggestedBudgetMinor),
        pickupArea: errand.locations.find((l) => l.type === 'ERRAND_PICKUP')?.area ?? null,
        destinationArea: errand.locations.find((l) => l.type === 'ERRAND_DESTINATION')?.area ?? null,
        pickupApprox: points.get(`${errand.id}:ERRAND_PICKUP`) ?? null,
        destinationApprox: points.get(`${errand.id}:ERRAND_DESTINATION`) ?? null,
        boost: boosts.get(errand.id) ?? null,
        offerCount: errand.offerCount,
        publishedAt: errand.publishedAt,
        expiresAt: errand.expiresAt,
        createdAt: errand.createdAt,
        updatedAt: errand.updatedAt,
      })),
      {
        hasNextPage,
        ...(hasNextPage && last
          ? { nextCursor: this.cursors.encode({ sort: last.sort_key, createdAt: last.ts, id: last.id }) }
          : {}),
      },
    );
  }

  /** How many errands sit behind each tab, so the tabs can show numbers. */
  async counts(userId: string): Promise<MineCountsDto> {
    await this.expireOverdue(userId);
    const rows = await this.prisma.$queryRaw<Array<MineCountsDto>>`
      SELECT count(*)::int AS "all",
             count(*) FILTER (WHERE ${ATTENTION_SQL})::int AS attention,
             count(*) FILTER (WHERE e.status = 'OPEN'::"ErrandStatus")::int AS open,
             count(*) FILTER (WHERE e.status::text = ANY(${TAB_STATUSES.ACTIVE as string[]}::text[]))::int AS active,
             count(*) FILTER (WHERE e.status::text = ANY(${TAB_STATUSES.PAST as string[]}::text[]))::int AS past,
             count(*) FILTER (WHERE e.status = 'DRAFT'::"ErrandStatus")::int AS draft
      FROM errands e
      WHERE e.requester_id = ${userId}::uuid AND e.deleted_at IS NULL
    `;
    return rows[0] ?? { all: 0, attention: 0, open: 0, active: 0, past: 0, draft: 0 };
  }

  /** The offer preview, the selected runner and the attention flag for one page of errands. */
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

  private async extras(
    userId: string,
    errands: Array<{ id: string; status: ErrandStatus; offerCount: number; expiresAt: Date | null }>,
  ): Promise<
    Map<string, Pick<ErrandSummaryDto, 'lowestOfferMinor' | 'offerPreview' | 'runner' | 'agreedAmountMinor' | 'assignmentId' | 'conversationId' | 'attention' | 'attentionExpiresAt'>>
  > {
    const ids = errands.map((errand) => errand.id);
    const out = new Map<string, Pick<ErrandSummaryDto, 'lowestOfferMinor' | 'offerPreview' | 'runner' | 'agreedAmountMinor' | 'assignmentId' | 'conversationId' | 'attention' | 'attentionExpiresAt'>>();
    if (ids.length === 0) return out;

    const [offers, assignments, changes] = await Promise.all([
      this.prisma.$queryRaw<Array<{ errand_id: string; amount: bigint; first_name: string; last_name: string | null; photo: string | null }>>`
        SELECT o.errand_id::text, o.amount_minor AS amount, u.first_name, u.last_name, pr.photo_media_id::text AS photo
        FROM offers o
        JOIN users u ON u.id = o.runner_id
        LEFT JOIN profiles pr ON pr.user_id = u.id AND pr.deleted_at IS NULL
        WHERE o.errand_id = ANY(${ids}::uuid[]) AND o.deleted_at IS NULL AND o.status = 'ACTIVE'::"OfferStatus"
        ORDER BY o.errand_id, o.amount_minor ASC, o.created_at ASC
      `,
      this.prisma.$queryRaw<
        Array<{
          errand_id: string;
          assignment_id: string;
          conversation_id: string | null;
          amount: bigint;
          first_name: string;
          last_name: string | null;
          photo: string | null;
          rating_avg: number | null;
          rating_count: number;
          completed: number;
          is_pro: boolean;
        }>
      >`
        SELECT DISTINCT ON (a.errand_id)
               a.errand_id::text, a.id::text AS assignment_id, cv.id::text AS conversation_id,
               a.agreed_amount_minor AS amount, u.first_name, u.last_name, pr.photo_media_id::text AS photo,
               us.runner_rating_avg::float8 AS rating_avg, COALESCE(us.runner_rating_count, 0)::int AS rating_count,
               COALESCE(us.completed_as_runner, 0)::int AS completed,
               EXISTS (SELECT 1 FROM entitlements en WHERE en.user_id = u.id AND en.type = 'RUNNER_PRO'::"EntitlementType" AND en.revoked_at IS NULL
                 AND en.valid_from <= clock_timestamp() AND (en.valid_until IS NULL OR en.valid_until > clock_timestamp())) AS is_pro
        FROM assignments a
        JOIN users u ON u.id = a.runner_id
        LEFT JOIN profiles pr ON pr.user_id = u.id AND pr.deleted_at IS NULL
        LEFT JOIN user_stats us ON us.user_id = u.id
        LEFT JOIN conversations cv ON cv.offer_id = a.selected_offer_id AND cv.deleted_at IS NULL
        WHERE a.errand_id = ANY(${ids}::uuid[]) AND a.deleted_at IS NULL
          AND a.status IN ('PENDING_ACCEPTANCE'::"AssignmentStatus", 'ACCEPTED'::"AssignmentStatus", 'COMPLETED'::"AssignmentStatus")
        ORDER BY a.errand_id, a.selected_at DESC
      `,
      this.prisma.$queryRaw<Array<{ errand_id: string; expires_at: Date }>>`
        SELECT DISTINCT ON (a.errand_id) a.errand_id::text, c.expires_at
        FROM change_requests c
        JOIN assignments a ON a.id = c.assignment_id AND a.deleted_at IS NULL
        WHERE a.errand_id = ANY(${ids}::uuid[]) AND c.deleted_at IS NULL
          AND c.status = 'PENDING'::"ChangeRequestStatus" AND c.requested_by <> ${userId}::uuid AND c.expires_at > now()
        ORDER BY a.errand_id, c.expires_at ASC
      `,
    ]);

    const offersByErrand = new Map<string, typeof offers>();
    for (const row of offers) offersByErrand.set(row.errand_id, [...(offersByErrand.get(row.errand_id) ?? []), row]);
    const assignmentByErrand = new Map(assignments.map((row) => [row.errand_id, row]));
    const changeByErrand = new Map(changes.map((row) => [row.errand_id, row.expires_at]));
    const soon = Date.now() + EXPIRING_WINDOW_HOURS * 3_600_000;

    for (const errand of errands) {
      const own = offersByErrand.get(errand.id) ?? [];
      const assignment = assignmentByErrand.get(errand.id);
      const open = errand.status === 'OPEN';
      const change = changeByErrand.get(errand.id) ?? null;
      let attention: ErrandAttention | null = null;
      let attentionExpiresAt: Date | null = null;
      if (errand.status === 'DELIVERED') attention = 'DELIVERY';
      else if (change) {
        attention = 'CHANGE_REQUEST';
        attentionExpiresAt = change;
      } else if (errand.status === 'RUNNER_SELECTED') attention = 'RUNNER_TO_CONFIRM';
      else if (open && errand.offerCount > 0) attention = 'OFFERS';
      if (open && errand.expiresAt && errand.expiresAt.getTime() <= soon) {
        // Closing soon outranks "has offers": the requester can still extend it once.
        attention = 'EXPIRING';
        attentionExpiresAt = errand.expiresAt;
      }
      out.set(errand.id, {
        lowestOfferMinor: open && own.length ? Number(own[0].amount) : null,
        offerPreview: open ? own.slice(0, 4).map((row) => ({ firstName: row.first_name, lastName: row.last_name, photoMediaId: row.photo })) : [],
        runner: assignment
          ? {
              firstName: assignment.first_name,
              lastName: assignment.last_name,
              photoMediaId: assignment.photo,
              rating: assignment.rating_avg,
              ratingCount: assignment.rating_count,
              completedErrands: assignment.completed,
              isPro: assignment.is_pro,
            }
          : null,
        agreedAmountMinor: assignment ? Number(assignment.amount) : null,
        assignmentId: assignment?.assignment_id ?? null,
        conversationId: assignment?.conversation_id ?? null,
        attention,
        attentionExpiresAt,
      });
    }
    return out;
  }

  private async expireOverdue(userId: string): Promise<void> {
    const overdue = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM errands
      WHERE requester_id = ${userId}::uuid AND status = 'OPEN'::"ErrandStatus" AND deleted_at IS NULL
        AND expires_at <= clock_timestamp()
      LIMIT 50
    `;
    for (const { id } of overdue) {
      await this.expiry.expireIfDue(id);
    }
  }
}

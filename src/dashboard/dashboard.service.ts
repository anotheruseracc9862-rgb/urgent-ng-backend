import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { ActivityItemDto, MeSummaryDto, DashboardRequesterDto, DashboardRunnerDto } from './dashboard.dto.js';

const RECENT_ACTIVITY = 8;
const SUCCESS_WINDOW_DAYS = 90;

/**
 * The numbers on the two dashboards in one call: what needs the user's attention as a requester
 * and as a runner, plus the latest activity. Every figure is a count over the user's own rows.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(userId: string): Promise<MeSummaryDto> {
    const [asRequester, asRunner, recentActivity] = await Promise.all([
      this.requester(userId),
      this.runner(userId),
      this.activity(userId),
    ]);
    return { asRequester, asRunner, recentActivity };
  }

  private async requester(userId: string): Promise<DashboardRequesterDto> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        errands_this_month: number;
        completed_this_month: number;
        open_errands: number;
        active_errands: number;
        ended_completed: number;
        ended_total: number;
        errands_with_offers: number;
        awaiting_acceptance: number;
        deliveries: number;
        offers_to_review: number;
        change_requests: number;
      }>
    >`
      SELECT
        count(*) FILTER (WHERE e.status <> 'DRAFT'::"ErrandStatus"
                          AND e.created_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')::int AS errands_this_month,
        count(*) FILTER (WHERE e.status = 'COMPLETED'::"ErrandStatus"
                          AND e.updated_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')::int AS completed_this_month,
        count(*) FILTER (WHERE e.status = 'OPEN'::"ErrandStatus")::int AS open_errands,
        count(*) FILTER (WHERE e.status IN ('ACCEPTED'::"ErrandStatus", 'IN_PROGRESS'::"ErrandStatus", 'PICKED_UP'::"ErrandStatus"))::int AS active_errands,
        count(*) FILTER (WHERE e.status = 'COMPLETED'::"ErrandStatus"
                          AND e.updated_at >= now() - make_interval(days => ${SUCCESS_WINDOW_DAYS}::int))::int AS ended_completed,
        count(*) FILTER (WHERE e.status IN ('COMPLETED'::"ErrandStatus", 'CANCELLED'::"ErrandStatus", 'EXPIRED'::"ErrandStatus")
                          AND e.updated_at >= now() - make_interval(days => ${SUCCESS_WINDOW_DAYS}::int))::int AS ended_total,
        count(*) FILTER (WHERE e.status = 'OPEN'::"ErrandStatus" AND e.offer_count > 0)::int AS errands_with_offers,
        count(*) FILTER (WHERE e.status = 'RUNNER_SELECTED'::"ErrandStatus")::int AS awaiting_acceptance,
        count(*) FILTER (WHERE e.status = 'DELIVERED'::"ErrandStatus")::int AS deliveries,
        (SELECT count(*)::int FROM offers o
          WHERE o.requester_id = ${userId}::uuid AND o.deleted_at IS NULL AND o.status = 'ACTIVE'::"OfferStatus"
            AND o.awaiting_party = 'REQUESTER'::"OfferAwaitingParty") AS offers_to_review,
        (SELECT count(*)::int FROM change_requests c JOIN assignments a ON a.id = c.assignment_id
          WHERE a.requester_id = ${userId}::uuid AND c.deleted_at IS NULL AND c.status = 'PENDING'::"ChangeRequestStatus"
            AND c.requested_by <> ${userId}::uuid AND c.expires_at > now()) AS change_requests
      FROM errands e
      WHERE e.requester_id = ${userId}::uuid AND e.deleted_at IS NULL
    `;
    const r = rows[0];
    const extra = await this.requesterTrends(userId);
    return {
      ...extra,
      errandsThisMonth: r.errands_this_month,
      completedThisMonth: r.completed_this_month,
      openErrands: r.open_errands,
      activeErrands: r.active_errands,
      successRate: r.ended_total === 0 ? null : Math.round((r.ended_completed / r.ended_total) * 100) / 100,
      errandsWithOffers: r.errands_with_offers,
      offersToReview: r.offers_to_review,
      awaitingRunnerAcceptance: r.awaiting_acceptance,
      deliveriesToConfirm: r.deliveries,
      changeRequestsToAnswer: r.change_requests,
    };
  }

  /** Weekly posting, offers per errand and time to select, all over the user's own errands. */
  private async requesterTrends(userId: string): Promise<Pick<DashboardRequesterDto, 'errandsPerWeek' | 'averageOffersPerErrand' | 'medianMinutesToSelect'>> {
    const [weeks, averages, selects] = await Promise.all([
      this.prisma.$queryRaw<Array<{ n: number; total: number }>>`
        SELECT w.n, count(e.id)::int AS total
        FROM generate_series(0, 3) AS w(n)
        LEFT JOIN errands e
          ON e.requester_id = ${userId}::uuid AND e.deleted_at IS NULL AND e.status <> 'DRAFT'::"ErrandStatus"
         AND e.created_at >= now() - make_interval(days => (w.n + 1) * 7)
         AND e.created_at < now() - make_interval(days => w.n * 7)
        GROUP BY w.n
        ORDER BY w.n DESC
      `,
      this.prisma.$queryRaw<Array<{ average: number | null }>>`
        SELECT avg(e.offer_count)::float8 AS average
        FROM errands e
        WHERE e.requester_id = ${userId}::uuid AND e.deleted_at IS NULL AND e.status <> 'DRAFT'::"ErrandStatus"
          AND e.published_at IS NOT NULL AND e.published_at >= now() - make_interval(days => ${SUCCESS_WINDOW_DAYS}::int)
      `,
      this.prisma.$queryRaw<Array<{ median: number | null }>>`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY first.minutes)::float8 AS median
        FROM (
          SELECT DISTINCT ON (a.errand_id)
                 extract(epoch FROM (a.selected_at - e.published_at)) / 60 AS minutes
          FROM assignments a
          JOIN errands e ON e.id = a.errand_id AND e.deleted_at IS NULL
          WHERE a.requester_id = ${userId}::uuid AND a.deleted_at IS NULL
            AND e.published_at IS NOT NULL AND a.selected_at >= e.published_at
            AND a.selected_at >= now() - make_interval(days => ${SUCCESS_WINDOW_DAYS}::int)
          ORDER BY a.errand_id, a.selected_at ASC
        ) first
      `,
    ]);
    const average = averages[0]?.average ?? null;
    const median = selects[0]?.median ?? null;
    return {
      errandsPerWeek: weeks.map((week) => week.total),
      averageOffersPerErrand: average === null ? null : Math.round(average * 10) / 10,
      medianMinutesToSelect: median === null ? null : Math.max(1, Math.round(median)),
    };
  }

  /** The last seven Lagos days: offers sent and times selected, oldest first, no gaps. */
  private async offersPerDay(userId: string): Promise<DashboardRunnerDto['offersPerDay']> {
    const rows = await this.prisma.$queryRaw<Array<{ day: string; sent: number; selected: number }>>`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
             (SELECT count(*)::int FROM offers o
               WHERE o.runner_id = ${userId}::uuid AND o.deleted_at IS NULL
                 AND (o.created_at AT TIME ZONE 'Africa/Lagos')::date = d.day) AS sent,
             (SELECT count(*)::int FROM assignments a
               WHERE a.runner_id = ${userId}::uuid AND a.deleted_at IS NULL
                 AND (a.selected_at AT TIME ZONE 'Africa/Lagos')::date = d.day) AS selected
      FROM (
        SELECT generate_series(
                 (now() AT TIME ZONE 'Africa/Lagos')::date - 6,
                 (now() AT TIME ZONE 'Africa/Lagos')::date,
                 interval '1 day'
               )::date AS day
      ) d
      ORDER BY d.day
    `;
    return rows.map((row) => ({ date: row.day, sent: row.sent, selected: row.selected }));
  }

  private async runner(userId: string): Promise<DashboardRunnerDto> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        active_assignments: number;
        selected_awaiting: number;
        completed_30: number;
        active_offers: number;
        offers_awaiting: number;
        offers_week: number;
        change_requests: number;
      }>
    >`
      SELECT
        (SELECT count(*)::int FROM assignments a
          WHERE a.runner_id = ${userId}::uuid AND a.deleted_at IS NULL
            AND a.status IN ('PENDING_ACCEPTANCE'::"AssignmentStatus", 'ACCEPTED'::"AssignmentStatus")) AS active_assignments,
        (SELECT count(*)::int FROM assignments a
          WHERE a.runner_id = ${userId}::uuid AND a.deleted_at IS NULL
            AND a.status = 'PENDING_ACCEPTANCE'::"AssignmentStatus" AND a.acceptance_deadline > now()) AS selected_awaiting,
        (SELECT count(*)::int FROM assignments a
          WHERE a.runner_id = ${userId}::uuid AND a.deleted_at IS NULL
            AND a.status = 'COMPLETED'::"AssignmentStatus" AND a.completed_at >= now() - interval '30 days') AS completed_30,
        (SELECT count(*)::int FROM offers o
          WHERE o.runner_id = ${userId}::uuid AND o.deleted_at IS NULL AND o.status = 'ACTIVE'::"OfferStatus") AS active_offers,
        (SELECT count(*)::int FROM offers o
          WHERE o.runner_id = ${userId}::uuid AND o.deleted_at IS NULL AND o.status = 'ACTIVE'::"OfferStatus"
            AND (o.awaiting_party = 'RUNNER'::"OfferAwaitingParty" OR o.needs_reconfirmation)) AS offers_awaiting,
        (SELECT count(*)::int FROM offers o
          WHERE o.runner_id = ${userId}::uuid AND o.deleted_at IS NULL AND o.created_at >= now() - interval '7 days') AS offers_week,
        (SELECT count(*)::int FROM change_requests c JOIN assignments a ON a.id = c.assignment_id
          WHERE a.runner_id = ${userId}::uuid AND c.deleted_at IS NULL AND c.status = 'PENDING'::"ChangeRequestStatus"
            AND c.requested_by <> ${userId}::uuid AND c.expires_at > now()) AS change_requests
    `;
    const r = rows[0];
    const offersPerDay = await this.offersPerDay(userId);
    return {
      offersPerDay,
      activeAssignments: r.active_assignments,
      selectedAwaitingYou: r.selected_awaiting,
      activeOffers: r.active_offers,
      offersAwaitingYou: r.offers_awaiting,
      offersThisWeek: r.offers_week,
      completedLast30Days: r.completed_30,
      changeRequestsToAnswer: r.change_requests,
    };
  }

  private async activity(userId: string): Promise<ActivityItemDto[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ errand_id: string; title: string; to_status: string; role: string; at: Date }>
    >`
      SELECT h.errand_id::text, e.title, h.to_status::text,
             CASE WHEN e.requester_id = ${userId}::uuid THEN 'REQUESTER' ELSE 'RUNNER' END AS role,
             h.created_at AS at
      FROM errand_status_history h
      JOIN errands e ON e.id = h.errand_id AND e.deleted_at IS NULL
      WHERE e.requester_id = ${userId}::uuid
         OR EXISTS (SELECT 1 FROM assignments a
                    WHERE a.errand_id = e.id AND a.runner_id = ${userId}::uuid AND a.deleted_at IS NULL)
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT ${RECENT_ACTIVITY}
    `;
    return rows.map((row) => ({
      type: 'ERRAND_STATUS',
      errandId: row.errand_id,
      errandTitle: row.title,
      status: row.to_status,
      role: row.role,
      at: row.at,
    }));
  }
}

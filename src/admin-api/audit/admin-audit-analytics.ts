import { Injectable } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditActorType, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { PrismaService } from '../../database/prisma.service.js';
import { Paginated } from '../../common/pagination/paginated.js';
import { PaginationQueryDto } from '../../common/pagination/pagination.dto.js';
import { AuditService } from '../../audit/audit.service.js';
import { NoEnvelope } from '../../common/decorators/no-envelope.decorator.js';
import { ApiEnveloped, ApiErrors } from '../../common/api/api-docs.js';
import { ReqCtx } from '../../auth/decorators/request-context.decorator.js';
import type { RequestContext } from '../../auth/auth-audit.service.js';
import { AdminAuth, CurrentAdmin, type AuthenticatedAdmin } from '../../admin/decorators/admin-auth.decorator.js';
import { AdminPager, likePattern } from '../common/admin-page.js';
import { AnyObjectDto } from '../common/any-object.dto.js';

const EXPORT_LIMIT = 10_000;

// ---- DTOs ----

export class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: AuditActorType }) @IsOptional() @IsEnum(AuditActorType) actorType?: AuditActorType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() actorId?: string;
  @ApiPropertyOptional({ description: 'An action name or the start of one, for example `admin.user.` or `errand.status_changed`.', maxLength: 80 })
  @IsOptional() @IsString() @MaxLength(80) action?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() entityId?: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) @IsOptional() @Type(() => Date) @IsDate() to?: Date;
}

export class AuditExportQueryDto {
  @ApiPropertyOptional({ enum: AuditActorType }) @IsOptional() @IsEnum(AuditActorType) actorType?: AuditActorType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() actorId?: string;
  @ApiPropertyOptional({ maxLength: 80 }) @IsOptional() @IsString() @MaxLength(80) action?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() entityId?: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) @IsOptional() @Type(() => Date) @IsDate() to?: Date;
}

export class AuthEventsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() adminId?: string;
}

export class AuditRowDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: AuditActorType }) actorType!: AuditActorType;
  @ApiProperty({ nullable: true, type: String }) actorId!: string | null;
  @ApiProperty() action!: string;
  @ApiProperty({ nullable: true, type: String }) entityType!: string | null;
  @ApiProperty({ nullable: true, type: String }) entityId!: string | null;
  @ApiProperty({ nullable: true, type: String }) reasonCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) requestId!: string | null;
  @ApiProperty({ type: Object, nullable: true }) metadata!: Record<string, unknown> | null;
  @ApiProperty({ type: Date }) createdAt!: Date;
}

export class AnalyticsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 365, default: 30, description: 'The window, in days, ending now.' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number = 30;
}

export class AnalyticsExportQueryDto extends AnalyticsQueryDto {
  @ApiProperty({ enum: ['overview', 'supply-demand', 'funnel', 'revenue'] })
  @IsIn(['overview', 'supply-demand', 'funnel', 'revenue']) report!: 'overview' | 'supply-demand' | 'funnel' | 'revenue';
}

// ---- Service ----

@Injectable()
export class AdminAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pager: AdminPager,
  ) {}

  private conditions(q: AuditExportQueryDto, after?: { createdAt: Date; id: string }): Prisma.Sql[] {
    const c: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (q.actorType) c.push(Prisma.sql`actor_type = ${q.actorType}::"AuditActorType"`);
    if (q.actorId) c.push(Prisma.sql`actor_id = ${q.actorId}::uuid`);
    if (q.action) c.push(Prisma.sql`action LIKE ${likePattern(q.action).replace(/^%/, '')}`);
    if (q.entityType) c.push(Prisma.sql`entity_type = ${q.entityType}`);
    if (q.entityId) c.push(Prisma.sql`entity_id = ${q.entityId}::uuid`);
    if (q.from) c.push(Prisma.sql`created_at >= ${q.from}::timestamptz`);
    if (q.to) c.push(Prisma.sql`created_at < ${q.to}::timestamptz`);
    if (after) c.push(Prisma.sql`(created_at, id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    return c;
  }

  async search(q: AuditQueryDto): Promise<Paginated<AuditRowDto>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; actor_type: AuditActorType; actor_id: string | null; action: string; entity_type: string | null;
        entity_id: string | null; reason_code: string | null; request_id: string | null; metadata: Record<string, unknown> | null; created_at: Date;
      }>
    >`
      SELECT id::text AS id, actor_type, actor_id::text AS actor_id, action, entity_type, entity_id::text AS entity_id,
             reason_code, request_id, metadata, created_at
      FROM audit_logs WHERE ${Prisma.join(this.conditions(q, after), ' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}
    `;
    return this.pager.page(rows.map((r) => ({ ...r, createdAt: r.created_at })), limit, (r): AuditRowDto => ({
      id: r.id, actorType: r.actor_type, actorId: r.actor_id, action: r.action, entityType: r.entity_type, entityId: r.entity_id,
      reasonCode: r.reason_code, requestId: r.request_id, metadata: r.metadata, createdAt: r.created_at,
    }));
  }

  async authEvents(q: { adminId?: string; cursor?: string; limit?: number }) {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const rows = await this.prisma.adminAuthEvent.findMany({
      where: {
        ...(q.adminId ? { adminId: q.adminId } : {}),
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return this.pager.page(rows, limit, (r) => ({
      id: r.id, createdAt: r.createdAt, event: r.event, adminId: r.adminId, email: r.email, reason: r.reason, ip: r.ip, requestId: r.requestId,
    }));
  }

  async exportCsv(q: AuditExportQueryDto): Promise<string> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; created_at: Date; actor_type: string; actor_id: string | null; action: string; entity_type: string | null; entity_id: string | null; reason_code: string | null; request_id: string | null }>
    >`
      SELECT id::text AS id, created_at, actor_type::text AS actor_type, actor_id::text AS actor_id, action, entity_type,
             entity_id::text AS entity_id, reason_code, request_id
      FROM audit_logs WHERE ${Prisma.join(this.conditions(q), ' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ${EXPORT_LIMIT}
    `;
    return toCsv(
      ['id', 'at', 'actorType', 'actorId', 'action', 'entityType', 'entityId', 'reasonCode', 'requestId'],
      rows.map((r) => [r.id, r.created_at.toISOString(), r.actor_type, r.actor_id, r.action, r.entity_type, r.entity_id, r.reason_code, r.request_id]),
    );
  }
}

/** One CSV cell: quoted, quotes doubled, and a leading quote against spreadsheet formulas. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

@Injectable()
export class AdminAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The product's headline numbers over the last `days` days (Product PRD section 3). */
  async overview(days: number) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        published: number; with_offer: number; completed: number; ended: number; first_offer_median: number | null;
        first_offer_p90: number | null; avg_rating: string | null; ratings: number; repeat_requesters: number; requesters: number;
      }>
    >`
      WITH win AS (SELECT clock_timestamp() - make_interval(days => ${days}::int) AS since),
      pub AS (
        SELECT e.id, e.requester_id, e.status, e.published_at,
               (SELECT min(o.created_at) FROM offers o WHERE o.errand_id = e.id AND o.deleted_at IS NULL) AS first_offer_at
        FROM errands e, win
        WHERE e.deleted_at IS NULL AND e.published_at IS NOT NULL AND e.published_at >= win.since
      )
      SELECT
        (SELECT count(*)::int FROM pub) AS published,
        (SELECT count(*)::int FROM pub WHERE first_offer_at IS NOT NULL) AS with_offer,
        (SELECT count(*)::int FROM pub WHERE status = 'COMPLETED'::"ErrandStatus") AS completed,
        (SELECT count(*)::int FROM pub WHERE status IN ('COMPLETED'::"ErrandStatus", 'CANCELLED'::"ErrandStatus", 'EXPIRED'::"ErrandStatus")) AS ended,
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_offer_at - published_at)) / 60) FROM pub WHERE first_offer_at IS NOT NULL) AS first_offer_median,
        (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (first_offer_at - published_at)) / 60) FROM pub WHERE first_offer_at IS NOT NULL) AS first_offer_p90,
        (SELECT avg(s.score)::numeric(4,2)::text FROM ratings r JOIN rating_scores s ON s.rating_id = r.id AND s.dimension = 'OVERALL'::"RatingDimension", win
           WHERE r.deleted_at IS NULL AND r.status = 'PUBLISHED'::"RatingStatus" AND r.revealed_at IS NOT NULL AND r.created_at >= win.since) AS avg_rating,
        (SELECT count(*)::int FROM ratings r, win WHERE r.deleted_at IS NULL AND r.status = 'PUBLISHED'::"RatingStatus" AND r.revealed_at IS NOT NULL AND r.created_at >= win.since) AS ratings,
        (SELECT count(*)::int FROM (SELECT requester_id FROM pub WHERE status = 'COMPLETED'::"ErrandStatus" GROUP BY requester_id HAVING count(*) >= 2) x) AS repeat_requesters,
        (SELECT count(*)::int FROM (SELECT requester_id FROM pub WHERE status = 'COMPLETED'::"ErrandStatus" GROUP BY requester_id) y) AS requesters
    `;
    const r = rows[0];
    const share = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 1000);
    return {
      windowDays: days,
      errandsPublished: r.published,
      errandsWithOffer: r.with_offer,
      shareReceivingOffer: share(r.with_offer, r.published),
      minutesToFirstOfferMedian: r.first_offer_median === null ? null : Math.round(r.first_offer_median * 10) / 10,
      minutesToFirstOfferP90: r.first_offer_p90 === null ? null : Math.round(r.first_offer_p90 * 10) / 10,
      errandsCompleted: r.completed,
      completionRate: share(r.completed, r.ended),
      averageRating: r.avg_rating === null ? null : Number(r.avg_rating),
      ratingsCount: r.ratings,
      repeatRequesterShare: share(r.repeat_requesters, r.requesters),
      requestersWithCompleted: r.requesters,
    };
  }

  /** Demand and supply per pickup area: errands posted, how many got an offer, and runners nearby. */
  async supplyAndDemand(days: number) {
    const rows = await this.prisma.$queryRaw<
      Array<{ area: string; errands: number; with_offer: number; completed: number; offers: number; runners: number }>
    >`
      WITH win AS (SELECT clock_timestamp() - make_interval(days => ${days}::int) AS since),
      demand AS (
        SELECT l.area, e.id AS errand_id, e.status,
               ST_Centroid(l.approx_point::geometry) AS pt,
               (SELECT count(*) FROM offers o WHERE o.errand_id = e.id AND o.deleted_at IS NULL) AS offers
        FROM errands e JOIN errand_locations l ON l.errand_id = e.id AND l.type = 'ERRAND_PICKUP'::"LocationType" AND l.deleted_at IS NULL, win
        WHERE e.deleted_at IS NULL AND e.published_at IS NOT NULL AND e.published_at >= win.since
      ),
      areas AS (
        SELECT area, count(*)::int AS errands,
               count(*) FILTER (WHERE offers > 0)::int AS with_offer,
               count(*) FILTER (WHERE status = 'COMPLETED'::"ErrandStatus")::int AS completed,
               COALESCE(sum(offers), 0)::int AS offers,
               ST_Centroid(ST_Collect(pt)) AS centre
        FROM demand GROUP BY area
      )
      SELECT a.area, a.errands, a.with_offer, a.completed, a.offers,
             (SELECT count(*)::int FROM runner_profiles r
               WHERE r.deleted_at IS NULL AND r.availability = 'AVAILABLE'::"RunnerAvailability"
                 AND ST_DWithin(r.area_center, a.centre::geography, 5000)) AS runners
      FROM areas a ORDER BY a.errands DESC, a.area
      LIMIT 100
    `;
    return rows.map((r) => ({
      area: r.area,
      errands: r.errands,
      errandsWithOffer: r.with_offer,
      errandsCompleted: r.completed,
      offers: r.offers,
      availableRunnersWithin5km: r.runners,
      errandsPerRunner: r.runners === 0 ? null : Math.round((r.errands / r.runners) * 100) / 100,
    }));
  }

  /** Where new users drop off, for runners and for requesters. */
  async funnel(days: number) {
    const rows = await this.prisma.$queryRaw<Array<Record<string, number>>>`
      WITH win AS (SELECT clock_timestamp() - make_interval(days => ${days}::int) AS since),
      cohort AS (SELECT u.id FROM users u, win WHERE u.deleted_at IS NULL AND u.created_at >= win.since)
      SELECT
        (SELECT count(*)::int FROM cohort) AS registered,
        (SELECT count(*)::int FROM cohort c JOIN users u ON u.id = c.id WHERE u.phone_verified_at IS NOT NULL OR u.email_verified_at IS NOT NULL) AS contact_verified,
        (SELECT count(*)::int FROM cohort c JOIN runner_profiles r ON r.user_id = c.id AND r.deleted_at IS NULL) AS runner_profile,
        (SELECT count(DISTINCT c.id)::int FROM cohort c JOIN verification_attempts v ON v.user_id = c.id AND v.status = 'VERIFIED'::"VerificationStatus" AND v.deleted_at IS NULL) AS runner_verified,
        (SELECT count(DISTINCT c.id)::int FROM cohort c JOIN offers o ON o.runner_id = c.id AND o.deleted_at IS NULL) AS first_offer,
        (SELECT count(DISTINCT c.id)::int FROM cohort c JOIN assignments a ON a.runner_id = c.id AND a.status = 'COMPLETED'::"AssignmentStatus" AND a.deleted_at IS NULL) AS first_job_done,
        (SELECT count(DISTINCT c.id)::int FROM cohort c JOIN errands e ON e.requester_id = c.id AND e.status <> 'DRAFT'::"ErrandStatus" AND e.deleted_at IS NULL) AS errand_posted,
        (SELECT count(DISTINCT c.id)::int FROM cohort c JOIN errands e ON e.requester_id = c.id AND e.offer_count > 0 AND e.deleted_at IS NULL) AS errand_got_offer,
        (SELECT count(DISTINCT c.id)::int FROM cohort c JOIN errands e ON e.requester_id = c.id AND e.status = 'COMPLETED'::"ErrandStatus" AND e.deleted_at IS NULL) AS errand_completed
    `;
    const r = rows[0];
    return {
      windowDays: days,
      all: { registered: r.registered, contactVerified: r.contact_verified },
      runners: { profile: r.runner_profile, verified: r.runner_verified, firstOffer: r.first_offer, firstJobDone: r.first_job_done },
      requesters: { posted: r.errand_posted, gotOffer: r.errand_got_offer, completed: r.errand_completed },
    };
  }

  /** What Urgent.ng itself sold: paid orders by product, per day and in total (VAT included, kobo). */
  async revenue(days: number) {
    const [byStream, byDay] = await Promise.all([
      this.prisma.$queryRaw<Array<{ type: string; orders: number; amount: bigint; refunded: bigint }>>`
        SELECT o.type::text AS type, count(*)::int AS orders, COALESCE(sum(o.amount_minor), 0)::bigint AS amount,
               COALESCE(sum((SELECT COALESCE(sum(r.amount_minor), 0) FROM refunds r JOIN payments p ON p.id = r.payment_id
                              WHERE p.order_id = o.id AND r.status = 'COMPLETED'::"RefundStatus")), 0)::bigint AS refunded
        FROM orders o
        WHERE o.status IN ('PAID'::"OrderStatus", 'REFUNDED'::"OrderStatus") AND o.paid_at >= clock_timestamp() - make_interval(days => ${days}::int)
        GROUP BY o.type ORDER BY o.type
      `,
      this.prisma.$queryRaw<Array<{ day: string; type: string; amount: bigint }>>`
        SELECT to_char(o.paid_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS day, o.type::text AS type, sum(o.amount_minor)::bigint AS amount
        FROM orders o
        WHERE o.status IN ('PAID'::"OrderStatus", 'REFUNDED'::"OrderStatus") AND o.paid_at >= clock_timestamp() - make_interval(days => ${days}::int)
        GROUP BY 1, 2 ORDER BY 1, 2
      `,
    ]);
    const streams = byStream.map((r) => ({ type: r.type, orders: r.orders, grossMinor: Number(r.amount), refundedMinor: Number(r.refunded), netMinor: Number(r.amount) - Number(r.refunded) }));
    return {
      windowDays: days,
      totalGrossMinor: streams.reduce((n, s) => n + s.grossMinor, 0),
      totalNetMinor: streams.reduce((n, s) => n + s.netMinor, 0),
      streams,
      daily: byDay.map((r) => ({ day: r.day, type: r.type, amountMinor: Number(r.amount) })),
    };
  }
}

// ---- Controller ----

/** Audit search and analytics (Backend PRD 24.4 areas 18 and 19). Export needs its own permission. */
@ApiTags('Admin audit and analytics')
@Controller('admin')
export class AdminAuditAnalyticsController {
  constructor(
    private readonly audit: AdminAuditService,
    private readonly analytics: AdminAnalyticsService,
    private readonly auditLog: AuditService,
  ) {}

  @Get('audit')
  @AdminAuth('AUDIT_VIEW')
  @ApiEnveloped(AuditRowDto, { isArray: true })
  @ApiErrors(400, 403)
  search(@Query() query: AuditQueryDto) {
    return this.audit.search(query);
  }

  @Get('audit/auth-events')
  @AdminAuth('AUDIT_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  @ApiErrors(400, 403)
  authEvents(@Query() query: AuthEventsQueryDto) {
    return this.audit.authEvents({ adminId: query.adminId, cursor: query.cursor, limit: query.limit });
  }

  /** The audit log as a file. Needs AUDIT_EXPORT, and the export itself is audited. */
  @Get('audit/export.csv')
  @NoEnvelope()
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The report as CSV.', content: { 'text/csv': { schema: { type: 'string' } } } })
  @AdminAuth('AUDIT_VIEW', 'AUDIT_EXPORT')
  @ApiErrors(400, 403)
  async export(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query() query: AuditExportQueryDto,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const csv = await this.audit.exportCsv(query);
    await this.auditLog.record({
      actorType: AuditActorType.ADMIN,
      actorId: admin.adminId,
      action: 'admin.audit.export',
      entityType: 'audit_log',
      requestId: ctx.requestId,
      ip: ctx.ip,
      metadata: { filters: query as unknown as Record<string, unknown> },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
    return csv;
  }

  @Get('analytics/overview')
  @AdminAuth('ANALYTICS_VIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403)
  overview(@Query() query: AnalyticsQueryDto) {
    return this.analytics.overview(query.days ?? 30);
  }

  @Get('analytics/supply-demand')
  @AdminAuth('ANALYTICS_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  @ApiErrors(400, 403)
  supplyDemand(@Query() query: AnalyticsQueryDto) {
    return this.analytics.supplyAndDemand(query.days ?? 30);
  }

  @Get('analytics/funnel')
  @AdminAuth('ANALYTICS_VIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403)
  funnel(@Query() query: AnalyticsQueryDto) {
    return this.analytics.funnel(query.days ?? 30);
  }

  @Get('analytics/revenue')
  @AdminAuth('ANALYTICS_VIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403)
  revenue(@Query() query: AnalyticsQueryDto) {
    return this.analytics.revenue(query.days ?? 30);
  }

  /** Any of the reports as a file. Needs ANALYTICS_EXPORT. */
  @Get('analytics/export.csv')
  @NoEnvelope()
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The report as CSV.', content: { 'text/csv': { schema: { type: 'string' } } } })
  @AdminAuth('ANALYTICS_VIEW', 'ANALYTICS_EXPORT')
  @ApiErrors(400, 403)
  async exportReport(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query() query: AnalyticsExportQueryDto,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const days = query.days ?? 30;
    let csv: string;
    if (query.report === 'overview') {
      const o = (await this.analytics.overview(days)) as unknown as Record<string, unknown>;
      csv = toCsv(['metric', 'value'], Object.entries(o));
    } else if (query.report === 'supply-demand') {
      const rows = await this.analytics.supplyAndDemand(days);
      csv = toCsv(
        ['area', 'errands', 'errandsWithOffer', 'errandsCompleted', 'offers', 'availableRunnersWithin5km', 'errandsPerRunner'],
        rows.map((r) => [r.area, r.errands, r.errandsWithOffer, r.errandsCompleted, r.offers, r.availableRunnersWithin5km, r.errandsPerRunner]),
      );
    } else if (query.report === 'funnel') {
      const f = await this.analytics.funnel(days);
      csv = toCsv(
        ['group', 'step', 'users'],
        [
          ...Object.entries(f.all).map(([k, v]) => ['all', k, v]),
          ...Object.entries(f.runners).map(([k, v]) => ['runners', k, v]),
          ...Object.entries(f.requesters).map(([k, v]) => ['requesters', k, v]),
        ],
      );
    } else {
      const r = await this.analytics.revenue(days);
      csv = toCsv(['day', 'type', 'amountMinor'], r.daily.map((d) => [d.day, d.type, d.amountMinor]));
    }
    await this.auditLog.record({
      actorType: AuditActorType.ADMIN,
      actorId: admin.adminId,
      action: 'admin.analytics.export',
      entityType: 'analytics',
      requestId: ctx.requestId,
      ip: ctx.ip,
      metadata: { report: query.report, days },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${query.report}.csv"`);
    return csv;
  }
}

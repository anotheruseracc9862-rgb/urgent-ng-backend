import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { CursorService, type CursorData } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { RunnerEligibilityService } from '../runner/runner-eligibility.service.js';
import { distanceBucket } from '../errands/location-privacy.js';
import { FEED_BOOST_SOURCE, pinRotationBucket, rotatePinned, type FeedBoostSource } from './feed-boost.hook.js';

/** How many boosted errands are considered for the pinned slots before the rotation picks. */
const PINNED_CANDIDATES = 30;
import { FeedRateLimiter } from './feed-rate-limiter.js';
import { sortForDisplay } from '../badges/badge.rules.js';
import { RiskFlagService } from '../risk/risk-flag.service.js';
import { attachMyOffers } from './my-offers.js';
import { errandGeographySql, runnerCoverageSql } from '../geography/geography.service.js';
import type { FeedItemDto, FeedQueryDto, FeedSort, MapPointDto, MapQueryDto, MarketplaceErrandDto, MarketplaceFilterDto } from './marketplace.dto.js';

/** What a feed row looks like straight from the database. */
/** The `recommended` sort groups errands into rings of this width around the runner's area centre. */
const RING_METRES = 2000;

export interface FeedRow {
  id: string;
  title: string;
  description: string;
  category_key: string;
  category_name: string;
  category_flow: 'TRANSIT' | 'SERVICE';
  priority: 'STANDARD' | 'URGENT';
  time_mode: 'ASAP' | 'SCHEDULED';
  scheduled_at: Date | null;
  suggested_budget_minor: bigint | null;
  published_at: Date;
  expires_at: Date;
  offer_count: number;
  requester_first_name: string;
  requester_photo_media_id: string | null;
  requester_rating_avg: number | null;
  requester_rating_count: number;
  requester_badges: string[] | null;
  pickup_area: string | null;
  pickup_lga: string | null;
  pickup_state: string | null;
  destination_area: string | null;
  destination_lga: string | null;
  destination_state: string | null;
  dist_m: number | null;
  saved: boolean;
}

/** The columns every feed-shaped query selects. */
export const FEED_COLUMNS = Prisma.sql`
  e.id::text AS id, e.title, e.description, c.key AS category_key, c.name AS category_name, c.flow::text AS category_flow,
  e.priority::text AS priority, e.time_mode::text AS time_mode, e.scheduled_at, e.suggested_budget_minor,
  e.published_at, e.expires_at, e.offer_count,
  u.first_name AS requester_first_name, pr.photo_media_id::text AS requester_photo_media_id,
  us.requester_rating_avg::float8 AS requester_rating_avg, COALESCE(us.requester_rating_count, 0)::int AS requester_rating_count,
  (SELECT array_agg(b.badge::text) FROM user_badges b
    WHERE b.user_id = u.id AND b.revoked_at IS NULL AND b.badge IN ('NEW_REQUESTER'::"BadgeType", 'PROMPT_PAYER'::"BadgeType")) AS requester_badges,
  pl.area AS pickup_area, pl.lga AS pickup_lga, pl.state AS pickup_state,
  dl.area AS destination_area, dl.lga AS destination_lga, dl.state AS destination_state
`;

/** Joins that go with FEED_COLUMNS. */
export const FEED_JOINS = Prisma.sql`
  JOIN categories c ON c.id = e.category_id
  JOIN users u ON u.id = e.requester_id
  LEFT JOIN profiles pr ON pr.user_id = u.id AND pr.deleted_at IS NULL
  LEFT JOIN user_stats us ON us.user_id = u.id
  LEFT JOIN errand_locations pl ON pl.errand_id = e.id AND pl.type = 'ERRAND_PICKUP'::"LocationType" AND pl.deleted_at IS NULL
  LEFT JOIN errand_locations dl ON dl.errand_id = e.id AND dl.type = 'ERRAND_DESTINATION'::"LocationType" AND dl.deleted_at IS NULL
`;

const area = (name: string | null, lga: string | null, state: string | null) => (name ? { area: name, lga, state } : null);

/** `ratingMinCount`: a public average needs at least this many published ratings (Backend PRD 20.4). */
export function toFeedItem(row: FeedRow, boosted = false, ratingMinCount = 3): FeedItemDto {
  return {
    id: row.id,
    title: row.title,
    category: { key: row.category_key, name: row.category_name, flow: row.category_flow },
    description: row.description,
    pickup: area(row.pickup_area, row.pickup_lga, row.pickup_state),
    destination: area(row.destination_area, row.destination_lga, row.destination_state),
    distance: row.dist_m === null ? null : distanceBucket(row.dist_m),
    timeMode: row.time_mode,
    priority: row.priority,
    scheduledAt: row.scheduled_at,
    suggestedBudgetMinor: row.suggested_budget_minor === null ? null : Number(row.suggested_budget_minor),
    requester: {
      firstName: row.requester_first_name,
      photoMediaId: row.requester_photo_media_id,
      rating: row.requester_rating_avg !== null && row.requester_rating_count >= ratingMinCount ? Number(row.requester_rating_avg) : null,
      ratingCount: row.requester_rating_count,
      badges: sortForDisplay(row.requester_badges ?? []),
    },
    postedAt: row.published_at,
    expiresAt: row.expires_at,
    offerCount: row.offer_count,
    boosted,
    saved: row.saved,
    myOffer: null,
  } as FeedItemDto;
}

/** An open errand the viewer may see: not expired, not theirs, no block either way. Uses alias `e` for errands. */
export function openErrandVisibleTo(userId: string): Prisma.Sql {
  return Prisma.sql`
    e.status = 'OPEN'::"ErrandStatus" AND e.deleted_at IS NULL AND e.expires_at > clock_timestamp()
    AND e.requester_id <> ${userId}::uuid
    AND NOT EXISTS (
      SELECT 1 FROM blocks b
      WHERE b.deleted_at IS NULL
        AND ((b.blocker_id = ${userId}::uuid AND b.blocked_id = e.requester_id)
          OR (b.blocker_id = e.requester_id AND b.blocked_id = ${userId}::uuid))
    )`;
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (match) => `\\${match}`);

/**
 * The marketplace feed, map and detail (Backend PRD 12). Everything here is built for a runner who
 * is allowed to browse: the gate runs first, then one SQL query inside the runner's own operating
 * circle. Distances come from the errand's approximate point and are put into buckets, and the
 * response types have no field for an exact coordinate, address or contact.
 */
@Injectable()
export class MarketplaceFeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly cursors: CursorService,
    private readonly eligibility: RunnerEligibilityService,
    private readonly limiter: FeedRateLimiter,
    @Inject(FEED_BOOST_SOURCE) private readonly boosts: FeedBoostSource,
    private readonly risk: RiskFlagService,
  ) {}

  // ---- Feed ----

  async feed(userId: string, query: FeedQueryDto): Promise<Paginated<FeedItemDto>> {
    await this.limiter.consume(userId);
    await this.eligibility.assertCanBrowseFeed(userId);

    const sort = query.sort ?? 'nearest';
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? this.decode(query.cursor, sort) : undefined;
    const maxPinned = await this.config.get('FEED_MAX_PINNED_BOOSTS_PER_PAGE');
    const ratingMin = await this.config.get('RATING_MIN_COUNT_FOR_AVERAGE');

    // Boosted errands are pinned on the first page only and left out of the normal list.
    const boostedIds = cursor ? [] : await this.boosts.activeBoostedErrandIds();
    // Every boosted errand this runner may see, then the slots are given out in turn (see rotatePinned).
    const candidates = boostedIds.length > 0 ? await this.query(userId, query, { only: boostedIds, limit: Math.max(maxPinned, PINNED_CANDIDATES), sort }) : [];
    const pinned = rotatePinned(candidates, maxPinned, pinRotationBucket());
    const pinnedIds = pinned.map((row) => row.id);

    const rows = await this.query(userId, query, { exclude: pinnedIds, limit: limit + 1, sort, cursor });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    // The size of the whole result, so the app can say "See all 42". Only the first page asks.
    const total = cursor ? undefined : await this.countVisible(userId, query);

    const items = [...pinned.map((row) => toFeedItem(row, true, ratingMin)), ...page.map((row) => toFeedItem(row, false, ratingMin))];
    await attachMyOffers(this.prisma, userId, items);
    return new Paginated(
      items,
      {
        hasNextPage,
        ...(total === undefined ? {} : { total }),
        ...(hasNextPage && last
          ? { nextCursor: this.cursors.encode({ sort: this.cursorValue(sort, last), createdAt: last.published_at, id: last.id }) }
          : {}),
      },
    );
  }

  /** How many open errands pass every filter inside the runner's circle. Same rules as the page itself. */
  private async countVisible(userId: string, query: FeedQueryDto): Promise<number> {
    const filters = await this.filters(userId, query, {});
    const rows = await this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT count(*)::int AS total
      FROM errands e
      JOIN runner_profiles me ON me.user_id = ${userId}::uuid AND me.deleted_at IS NULL
      JOIN categories c ON c.id = e.category_id
      ${this.locationJoins(query)}
      WHERE ${filters}
    `);
    return rows[0]?.total ?? 0;
  }

  /** Pickup and destination rows, joined only when a text search needs the area names. */
  private locationJoins(query: MarketplaceFilterDto): Prisma.Sql {
    return query.q?.trim()
      ? Prisma.sql`
          LEFT JOIN errand_locations pl ON pl.errand_id = e.id AND pl.type = 'ERRAND_PICKUP'::"LocationType" AND pl.deleted_at IS NULL
          LEFT JOIN errand_locations dl ON dl.errand_id = e.id AND dl.type = 'ERRAND_DESTINATION'::"LocationType" AND dl.deleted_at IS NULL`
      : Prisma.empty;
  }

  // ---- Map ----

  async map(userId: string, query: MapQueryDto): Promise<MapPointDto[]> {
    await this.limiter.consume(userId);
    await this.eligibility.assertCanBrowseFeed(userId);
    const limit = query.limit ?? 100;
    const boosted = new Set(await this.boosts.activeBoostedErrandIds());

    const ranked = await this.rankedSql(userId, query, { limit, sort: 'nearest' });
    const rows = await this.prisma.$queryRaw<Array<FeedRow & { approx_lat: number; approx_lng: number }>>(Prisma.sql`
      WITH page AS (${ranked})
      SELECT ${FEED_COLUMNS}, page.dist_m,
             ST_Y(e.feed_point::geometry) AS approx_lat, ST_X(e.feed_point::geometry) AS approx_lng,
             false AS saved
      FROM page
      JOIN errands e ON e.id = page.id::uuid
      ${FEED_JOINS}
      ORDER BY page.dist_m ASC, page.published_at DESC, page.id DESC
    `);
    const points: MapPointDto[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      categoryKey: row.category_key,
      area: row.pickup_area ?? row.destination_area ?? '',
      approx: { lat: row.approx_lat, lng: row.approx_lng },
      priority: row.priority,
      suggestedBudgetMinor: row.suggested_budget_minor === null ? null : Number(row.suggested_budget_minor),
      distance: row.dist_m === null ? null : distanceBucket(row.dist_m),
      boosted: boosted.has(row.id),
      myOffer: null,
    }));
    await attachMyOffers(this.prisma, userId, points);
    return points;
  }

  // ---- Detail ----

  /**
   * An open errand as another user may see it. An errand that is not open, that the viewer has
   * blocked (or is blocked by), or that the viewer posted themselves, does not exist for them here.
   */
  async detail(userId: string, errandId: string): Promise<MarketplaceErrandDto> {
    await this.limiter.consume(userId);
    await this.eligibility.assertCanBrowseFeed(userId);
    const result = await this.loadDetail(userId, errandId);
    await this.recordOpen(errandId, userId);
    return result;
  }

  /** Remember that this runner opened the errand. It is counted for the boost results, never listed, and never blocks the page. */
  private async recordOpen(errandId: string, viewerId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO errand_views (errand_id, viewer_id) VALUES (${errandId}::uuid, ${viewerId}::uuid)
        ON CONFLICT (errand_id, viewer_id) DO UPDATE SET last_viewed_at = clock_timestamp(), view_count = errand_views.view_count + 1
      `;
    } catch {
      // Counting is a courtesy. A failure here must not break the page.
    }
  }

  private async loadDetail(userId: string, errandId: string): Promise<MarketplaceErrandDto> {
    const rows = await this.prisma.$queryRaw<
      Array<
        FeedRow & {
          instructions: string | null;
          item_size: MarketplaceErrandDto['itemSize'];
          item_value_minor: bigint | null;
          pickup_lat: number | null;
          pickup_lng: number | null;
          destination_lat: number | null;
          destination_lng: number | null;
          centre_key: string | null;
        }
      >
    >(Prisma.sql`
      SELECT ${FEED_COLUMNS}, e.instructions, e.item_size::text AS item_size, e.item_value_minor,
             ST_Y(pl.approx_point::geometry) AS pickup_lat, ST_X(pl.approx_point::geometry) AS pickup_lng,
             ST_Y(dl.approx_point::geometry) AS destination_lat, ST_X(dl.approx_point::geometry) AS destination_lng,
             round(ST_Distance(e.feed_point, me.area_center))::int AS dist_m,
             ST_AsText(ST_SnapToGrid(me.area_center::geometry, 0.0001)) AS centre_key,
             EXISTS (SELECT 1 FROM saved_errands s WHERE s.user_id = ${userId}::uuid AND s.errand_id = e.id AND s.deleted_at IS NULL) AS saved
      FROM errands e
      LEFT JOIN runner_profiles me ON me.user_id = ${userId}::uuid AND me.deleted_at IS NULL
      ${FEED_JOINS}
      WHERE e.id = ${errandId}::uuid AND ${openErrandVisibleTo(userId)}
        AND ${errandGeographySql(await this.config.get('INTERSTATE_ERRANDS_ENABLED'))}
        AND ${runnerCoverageSql('me')} AND NOT (e.category_id = ANY(me.excluded_category_ids))
    `);
    const row = rows[0];
    if (!row) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    await this.risk.watchProbing(userId, errandId, row.centre_key);
    const photos = await this.prisma.client.errandMedia.findMany({ where: { errandId }, orderBy: { position: 'asc' } });
    const base = toFeedItem(row, (await this.boosts.activeBoostedErrandIds()).includes(row.id), await this.config.get('RATING_MIN_COUNT_FOR_AVERAGE'));
    const point = (lat: number | null, lng: number | null, place: { area: string; lga: string | null; state: string | null } | null) =>
      place && lat !== null && lng !== null ? { ...place, approx: { lat, lng } } : null;
    await attachMyOffers(this.prisma, userId, [base]);
    return {
      ...base,
      instructions: row.instructions,
      itemSize: row.item_size,
      itemValueMinor: row.item_value_minor === null ? null : Number(row.item_value_minor),
      pickupApprox: point(row.pickup_lat, row.pickup_lng, base.pickup),
      destinationApprox: point(row.destination_lat, row.destination_lng, base.destination),
      photos: photos.map((photo) => ({ mediaId: photo.mediaId, position: photo.position })),
    };
  }

  // ---- Query building ----

  /** Visibility plus the runner's circle, categories and the caller's filters. */
  private async filters(userId: string, query: MarketplaceFilterDto, extra: { only?: string[]; exclude?: string[] }): Promise<Prisma.Sql> {
    const parts: Prisma.Sql[] = [
      openErrandVisibleTo(userId),
      errandGeographySql(await this.config.get('INTERSTATE_ERRANDS_ENABLED')),
      runnerCoverageSql('me', query.radiusKm),
      Prisma.sql`NOT (e.category_id = ANY(me.excluded_category_ids))`,
    ];
    if (query.category?.length) parts.push(Prisma.sql`c.key = ANY(${query.category}::text[])`);
    if (query.budgetMin !== undefined) parts.push(Prisma.sql`e.suggested_budget_minor >= ${query.budgetMin}::bigint`);
    if (query.budgetMax !== undefined) parts.push(Prisma.sql`e.suggested_budget_minor <= ${query.budgetMax}::bigint`);
    if (query.timeMode) parts.push(Prisma.sql`e.time_mode = ${query.timeMode}::"TimeMode"`);
    const text = query.q?.trim();
    if (text) {
      const like = `%${escapeLike(text)}%`;
      parts.push(Prisma.sql`(
        e.search_vector @@ websearch_to_tsquery('simple', ${text})
        OR c.name ILIKE ${like} OR pl.area ILIKE ${like} OR dl.area ILIKE ${like}
      )`);
    }
    if (extra.only) parts.push(Prisma.sql`e.id = ANY(${extra.only}::uuid[])`);
    if (extra.exclude?.length) parts.push(Prisma.sql`NOT (e.id = ANY(${extra.exclude}::uuid[]))`);
    return Prisma.join(parts, ' AND ');
  }

  private async query(
    userId: string,
    query: FeedQueryDto,
    options: { only?: string[]; exclude?: string[]; limit: number; sort: FeedSort; cursor?: CursorData },
  ): Promise<FeedRow[]> {
    return this.prisma.$queryRaw<FeedRow[]>(await this.feedSql(userId, query, options));
  }

  /** The feed query itself, so the performance check can run EXPLAIN on exactly what the service runs. */
  async feedSql(
    userId: string,
    query: FeedQueryDto,
    options: { only?: string[]; exclude?: string[]; limit: number; sort: FeedSort; cursor?: CursorData },
  ): Promise<Prisma.Sql> {
    const order =
      options.sort === 'newest'
        ? Prisma.sql`page.published_at DESC, page.id DESC`
        : options.sort === 'budget_desc'
          ? Prisma.sql`page.budget DESC, page.published_at DESC, page.id DESC`
          : options.sort === 'recommended'
            ? Prisma.sql`page.dist_ring ASC, page.published_at DESC, page.id DESC`
            : Prisma.sql`page.dist_m ASC, page.published_at DESC, page.id DESC`;

    // Two steps keep the query cheap in a busy area: first pick the ids of the page using only the
    // columns the filters and the sort need, then fetch the details of those few rows.
    return Prisma.sql`
      WITH page AS (${await this.rankedSql(userId, query, options)})
      SELECT ${FEED_COLUMNS}, page.dist_m,
             EXISTS (SELECT 1 FROM saved_errands s WHERE s.user_id = ${userId}::uuid AND s.errand_id = e.id AND s.deleted_at IS NULL) AS saved
      FROM page
      JOIN errands e ON e.id = page.id::uuid
      ${FEED_JOINS}
      ORDER BY ${order}
    `;
  }

  /**
   * Step one: the ids (with distance and publish time) of one page, after every filter, the
   * runner's circle and the cursor. Location rows are joined only when a text search needs the area.
   */
  private async rankedSql(
    userId: string,
    query: MarketplaceFilterDto,
    options: { only?: string[]; exclude?: string[]; limit: number; sort: FeedSort; cursor?: CursorData },
  ): Promise<Prisma.Sql> {
    const filters = await this.filters(userId, query, options);
    const { cursor, sort } = options;
    const tie = (c: CursorData) => Prisma.sql`(published_at, id) < (${c.createdAt}::timestamptz, ${c.id}::text)`;
    const keyset = !cursor
      ? Prisma.sql`TRUE`
      : sort === 'newest'
        ? tie(cursor)
        : sort === 'budget_desc'
          ? Prisma.sql`(budget < ${Number(cursor.sort)}::bigint OR (budget = ${Number(cursor.sort)}::bigint AND ${tie(cursor)}))`
          : sort === 'recommended'
            ? Prisma.sql`(COALESCE(dist_ring, -1) > ${Number(cursor.sort)}::int OR (COALESCE(dist_ring, -1) = ${Number(cursor.sort)}::int AND ${tie(cursor)}))`
            : Prisma.sql`(COALESCE(dist_m, -1) > ${Number(cursor.sort)}::int OR (COALESCE(dist_m, -1) = ${Number(cursor.sort)}::int AND ${tie(cursor)}))`;
    const order =
      sort === 'newest'
        ? Prisma.sql`published_at DESC, id DESC`
        : sort === 'budget_desc'
          ? Prisma.sql`budget DESC, published_at DESC, id DESC`
          : sort === 'recommended'
            ? Prisma.sql`dist_ring ASC, published_at DESC, id DESC`
            : Prisma.sql`dist_m ASC, published_at DESC, id DESC`;
    const locations = this.locationJoins(query);

    return Prisma.sql`
      SELECT ranked.id, ranked.published_at, ranked.dist_m, ranked.budget, ranked.dist_ring FROM (
        SELECT e.id::text AS id, e.published_at, round(ST_Distance(e.feed_point, me.area_center))::int AS dist_m,
               COALESCE(e.suggested_budget_minor, 0)::bigint AS budget,
               floor(ST_Distance(e.feed_point, me.area_center) / ${RING_METRES})::int AS dist_ring
        FROM errands e
        JOIN runner_profiles me ON me.user_id = ${userId}::uuid AND me.deleted_at IS NULL
        JOIN categories c ON c.id = e.category_id
        ${locations}
        WHERE ${filters}
      ) ranked
      WHERE ${keyset}
      ORDER BY ${order}
      LIMIT ${options.limit}
    `;
  }

  /** The value the next page continues from, per sort order. */
  private cursorValue(sort: FeedSort, last: FeedRow): number | string {
    switch (sort) {
      case 'newest':
        return last.published_at.toISOString();
      case 'budget_desc':
        return Number(last.suggested_budget_minor ?? 0);
      case 'recommended':
        return last.dist_m === null ? -1 : Math.floor(last.dist_m / RING_METRES);
      default:
        return last.dist_m ?? -1;
    }
  }

  private decode(raw: string, sort: FeedSort): CursorData {
    const cursor = this.cursors.decode(raw);
    const wrongKind = sort === 'newest' ? typeof cursor.sort !== 'string' : typeof cursor.sort !== 'number';
    if (wrongKind) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'This cursor belongs to a different sort order.', details: { field: 'cursor' } });
    }
    return cursor;
  }
}

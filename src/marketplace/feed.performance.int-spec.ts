/**
 * P5-09: feed performance with 50,000 errands. Opt-in because it seeds a lot of rows:
 *
 *   RUN_PERF=1 npx vitest run --config ./vitest.config.int.ts src/marketplace/feed.performance.int-spec.ts
 *
 * It runs against the test database, prints the measured timings and the query plan, and fails
 * when the feed's p95 is over the target (600 ms, Backend PRD 33.1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies } from '../test/auth.helper.js';
import { NIN, readyRunner, type TestUser } from '../test/verification.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { MarketplaceFeedService } from './marketplace-feed.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

const TOTAL = 50_000;
const TARGET_P95_MS = 600;
const REQUESTS = 120;

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

describe.skipIf(!process.env.RUN_PERF)('Feed performance with 50,000 errands (P5-09)', () => {
  let app: INestApplication;
  let runner: TestUser;
  const prisma = getTestPrisma();
  const report: Record<string, unknown> = {};

  beforeAll(async () => {
    app = await createTestApp();
    await cleanAll();
    await seedPolicies();
    const categories = await seedCategories();
    runner = await readyRunner(app, NIN.ok);

    // 500 requesters.
    await prisma.$executeRaw`
      INSERT INTO users (id, name, first_name, last_name, password_hash, status, phone_e164, phone_verified_at, updated_at)
      SELECT uuid_generate_v7(), 'Requester ' || g, 'Req' || g, 'User', 'x', 'ACTIVE'::"UserStatus", '+23470' || lpad(g::text, 8, '0'), now(), now()
      FROM generate_series(1, 500) g`;
    const categoryIds = Object.values(categories);

    const started = Date.now();
    // 50,000 errands over a 40 km box around Lagos: 60% open, the rest in other states.
    await prisma.$executeRaw`
      CREATE TEMP TABLE seed_errands AS
      SELECT uuid_generate_v7() AS id, g,
             (SELECT id FROM users WHERE name LIKE 'Requester %' ORDER BY id OFFSET (g % 500) LIMIT 1) AS requester_id,
             (${categoryIds}::uuid[])[1 + (g % ${categoryIds.length})] AS category_id,
             CASE WHEN g % 10 < 6 THEN 'OPEN' WHEN g % 10 = 6 THEN 'COMPLETED' WHEN g % 10 = 7 THEN 'CANCELLED' WHEN g % 10 = 8 THEN 'EXPIRED' ELSE 'ACCEPTED' END AS status,
             now() - (random() * interval '20 hours') AS pub,
             (ARRAY['parcel','cake','keys','laptop','groceries','documents','flowers','charger'])[1 + (g % 8)] AS word,
             6.40 + random() * 0.35 AS lat, 3.20 + random() * 0.40 AS lng
      FROM generate_series(1, ${TOTAL}) g`;
    await prisma.$executeRaw`
      INSERT INTO errands (id, requester_id, category_id, title, description, status, priority, time_mode,
                           prohibited_items_confirmed_at, prohibited_policy_version, published_at, expires_at,
                           completed_at, cancelled_at, cancellation_reason, suggested_budget_minor, feed_point, created_at, updated_at)
      SELECT id, requester_id, category_id, 'Errand ' || g || ' ' || word, 'Please handle the ' || word || ' for me, number ' || g,
             status::"ErrandStatus", 'URGENT'::"ErrandPriority", 'ASAP'::"TimeMode", now(), '1.0', pub,
             CASE WHEN status = 'OPEN' THEN now() + interval '1 hour' + random() * interval '23 hours' ELSE pub + interval '24 hours' END,
             CASE WHEN status = 'COMPLETED' THEN now() END,
             CASE WHEN status = 'CANCELLED' THEN now() END,
             CASE WHEN status = 'CANCELLED' THEN 'REQUESTER_CANCELLED'::"ErrandCancellationReason" END,
             (100000 + (g % 50) * 20000)::bigint,
             ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, pub, now()
      FROM seed_errands`;
    await prisma.$executeRaw`
      INSERT INTO errand_locations (errand_id, type, exact_point, approx_point, area, lga, state, state_id, lga_id, source, updated_at)
      SELECT id, 'ERRAND_PICKUP'::"LocationType", ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
             ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, 'Area ' || (g % 40), 'Lagos Mainland', 'Lagos', 'ng-lagos', 'ng-lagos:lagos-mainland', 'MAP_PIN'::"LocationSource", now()
      FROM seed_errands`;
    await prisma.$executeRaw`
      INSERT INTO errand_locations (errand_id, type, exact_point, approx_point, area, lga, state, state_id, lga_id, source, updated_at)
      SELECT id, 'ERRAND_DESTINATION'::"LocationType", ST_SetSRID(ST_MakePoint(lng + 0.01, lat + 0.01), 4326)::geography,
             ST_SetSRID(ST_MakePoint(lng + 0.01, lat + 0.01), 4326)::geography, 'Area ' || ((g + 7) % 40), 'Lagos Mainland', 'Lagos', 'ng-lagos', 'ng-lagos:lagos-mainland', 'MAP_PIN'::"LocationSource", now()
      FROM seed_errands WHERE g % 5 < 3`;
    await prisma.$executeRawUnsafe('ANALYZE errands');
    await prisma.$executeRawUnsafe('ANALYZE errand_locations');
    report.seedSeconds = (Date.now() - started) / 1000;

    // Runner area in the middle of the box: 5 km (a typical runner) and later 20 km (the widest allowed).
    await request(app.getHttpServer())
      .put(`${API}/runner/profile`)
      .set(...bearer(runner.accessToken))
      .send({ transport: 'MOTORCYCLE', areaCenter: { lat: 6.575, lng: 3.4 }, areaRadiusKm: 5 })
      .expect(200);
  }, 600_000);

  afterAll(async () => {
    const text = JSON.stringify(report, null, 2);
    if (process.env.PERF_REPORT) writeFileSync(process.env.PERF_REPORT, text);
    // eslint-disable-next-line no-console
    console.log('\nP5-09 feed performance report\n' + text);
    await app.close();
  });

  const measure = async (name: string, path: string) => {
    const times: number[] = [];
    let size = 0;
    for (let i = 0; i < REQUESTS; i += 1) {
      const t0 = performance.now();
      const res = await request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(runner.accessToken));
      times.push(performance.now() - t0);
      expect(res.status, `${name}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      size = res.body.data.length;
    }
    times.sort((a, b) => a - b);
    const stats = { items: size, p50: Math.round(percentile(times, 50)), p95: Math.round(percentile(times, 95)), max: Math.round(times[times.length - 1]) };
    report[name] = stats;
    return stats;
  };

  it('keeps p95 under the target for every common feed request', async () => {
    const cases: Array<[string, string]> = [
      ['nearest, first page', '/marketplace/errands?sort=nearest&limit=20'],
      ['newest, first page', '/marketplace/errands?sort=newest&limit=20'],
      ['filtered by category and budget', '/marketplace/errands?category=delivery,pickup&budgetMin=200000&budgetMax=900000'],
      ['search "cake"', '/marketplace/errands?q=cake'],
      ['search by area "Area 7"', '/marketplace/errands?q=Area%207'],
      ['narrowed to 2 km', '/marketplace/errands?radiusKm=2'],
      ['map', '/marketplace/errands/map?limit=100'],
    ];
    for (const [name, path] of cases) {
      const stats = await measure(name, path);
      expect(stats.p95, `${name} p95 ${stats.p95} ms`).toBeLessThan(TARGET_P95_MS);
    }
  }, 600_000);

  it('keeps a deep page as fast as the first (keyset paging, not offset)', async () => {
    let cursor: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const res = await request(app.getHttpServer())
        .get(`${API}/marketplace/errands?sort=nearest&limit=20${cursor ? `&cursor=${cursor}` : ''}`)
        .set(...bearer(runner.accessToken))
        .expect(200);
      cursor = res.body.meta.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeTruthy();
    const deep = await measure('nearest, 9th page', `/marketplace/errands?sort=nearest&limit=20&cursor=${cursor}`);
    expect(deep.p95).toBeLessThan(TARGET_P95_MS);
  }, 600_000);

  it('with the widest area (20 km) still meets the target', async () => {
    await request(app.getHttpServer())
      .put(`${API}/runner/profile`)
      .set(...bearer(runner.accessToken))
      .send({ transport: 'MOTORCYCLE', areaCenter: { lat: 6.575, lng: 3.4 }, areaRadiusKm: 20 })
      .expect(200);
    const nearest = await measure('20 km area, nearest', '/marketplace/errands?sort=nearest&limit=20');
    const newest = await measure('20 km area, newest', '/marketplace/errands?sort=newest&limit=20');
    expect(nearest.p95).toBeLessThan(TARGET_P95_MS);
    expect(newest.p95).toBeLessThan(TARGET_P95_MS);
  }, 600_000);

  it('records the query plan', async () => {
    const service = app.get(MarketplaceFeedService);
    for (const sort of ['nearest', 'newest'] as const) {
      const sql = await service.feedSql(runner.userId, { limit: 20, sort }, { limit: 21, sort, exclude: [] });
      try {
        const plan = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${sql.text}`, ...sql.values);
        report[`plan ${sort}`] = plan.map((row) => row['QUERY PLAN']);
      } catch (error) {
        report[`plan ${sort}`] = String(error instanceof Error ? error.message : error).slice(0, 600);
      }
    }
    expect(Object.keys(report).some((key) => key.startsWith('plan'))).toBe(true);
  }, 120_000);
});

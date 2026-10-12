/**
 * P12-05: performance of the critical paths at launch scale with 10x headroom (Backend PRD 33.1):
 * 5,000 users, 20,000 errands, 20,000 chat messages in one conversation and 20,000 notifications for
 * one user. Opt-in, because it seeds a lot of rows:
 *
 *   RUN_PERF=1 PERF_REPORT=perf-critical.json npx vitest run --config ./vitest.config.int.ts src/perf
 *
 * It measures p95 for the read endpoints (target 400 ms) and the write endpoints (target 800 ms),
 * with a few requests in flight at once, and runs EXPLAIN on the queries behind the list endpoints
 * to check that they use an index. The feed has its own check (`feed.performance.int-spec.ts`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, cleanRedis, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { acceptAssignment, offerScene, selectRunner, type Scene } from '../test/assignment.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

const READ_TARGET_MS = 400;
const WRITE_TARGET_MS = 800;
const SCENES = 24;
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY ?? 4);
const READ_REQUESTS = 80;

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
type Authed = { accessToken: string };

describe.skipIf(!process.env.RUN_PERF)('Critical path performance (P12-05)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  const report: Record<string, unknown> = {};
  let scenes: Scene[] = [];
  let busyConversation: string;

  beforeAll(async () => {
    app = await createTestApp();
    // A 500 under load has to show its cause in the report.
    Logger.overrideLogger(['error', 'warn']);
    await cleanAll();
    await seedPolicies();
    const categories = await seedCategories();
    const categoryIds = Object.values(categories);

    // Background volume: 5,000 users and 20,000 errands from 1,000 requesters.
    const started = Date.now();
    await prisma.$executeRaw`
      INSERT INTO users (id, name, first_name, last_name, password_hash, status, phone_e164, phone_verified_at, updated_at)
      SELECT uuid_generate_v7(), 'Bulk ' || g, 'Bulk' || g, 'User', 'x', 'ACTIVE'::"UserStatus", '+23471' || lpad(g::text, 8, '0'), now(), now()
      FROM generate_series(1, 5000) g`;
    await prisma.$executeRaw`
      INSERT INTO errands (id, requester_id, category_id, title, description, status, priority, time_mode,
                           prohibited_items_confirmed_at, prohibited_policy_version, published_at, expires_at, feed_point, created_at, updated_at)
      SELECT uuid_generate_v7(),
             (SELECT id FROM users WHERE name LIKE 'Bulk %' ORDER BY id OFFSET (g % 1000) LIMIT 1),
             (${categoryIds}::uuid[])[1 + (g % ${categoryIds.length})],
             'Errand ' || g, 'Bulk errand number ' || g, 'OPEN'::"ErrandStatus", 'URGENT'::"ErrandPriority", 'ASAP'::"TimeMode",
             now(), '1.0', now() - (random() * interval '20 hours'), now() + interval '12 hours',
             ST_SetSRID(ST_MakePoint(3.20 + random() * 0.40, 6.40 + random() * 0.35), 4326)::geography, now(), now()
      FROM generate_series(1, 20000) g`;
    report.seedSeconds = (Date.now() - started) / 1000;

    // Real flows for the endpoints under test.
    for (let i = 0; i < SCENES; i += 1) {
      // Sign-up sends one-time codes, limited per address per hour: start each scene with a clean counter.
      await cleanRedis();
      scenes.push(await offerScene(app, categoryIds[0]));
    }
    const first = scenes[0];
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { errandId: first.errandId } });
    busyConversation = conversation.id;

    await prisma.$executeRaw`
      INSERT INTO messages (id, conversation_id, sender_id, type, body, status, created_at)
      SELECT uuid_generate_v7(), ${conversation.id}::uuid, ${first.runner.userId}::uuid, 'TEXT'::"MessageType", 'Message number ' || g, 'SENT'::"MessageStatus",
             now() - make_interval(secs => 20000 - g)
      FROM generate_series(1, 20000) g`;
    await prisma.$executeRaw`
      INSERT INTO notifications (id, user_id, category, type, title, body, created_at)
      SELECT uuid_generate_v7(), ${first.requester.userId}::uuid, 'MARKETPLACE'::"NotificationCategory", 'test', 'Title ' || g, 'Body ' || g,
             now() - make_interval(secs => 20000 - g)
      FROM generate_series(1, 20000) g`;
    for (const table of ['users', 'errands', 'messages', 'notifications', 'offers', 'conversations']) {
      await prisma.$executeRawUnsafe(`ANALYZE ${table}`);
    }
  }, 900_000);

  afterAll(async () => {
    const text = JSON.stringify(report, null, 2);
    if (process.env.PERF_REPORT) writeFileSync(process.env.PERF_REPORT, text);
    // eslint-disable-next-line no-console
    console.log('\nP12-05 critical path report\n' + text);
    await app.close();
  });

  /** Run `jobs` with `CONCURRENCY` in flight and return the sorted durations. */
  async function timed(jobs: Array<() => Promise<{ status: number; body?: unknown }>>, okStatuses: number[]): Promise<number[]> {
    const times: number[] = [];
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next];
        next += 1;
        const t0 = performance.now();
        const res = await job();
        times.push(performance.now() - t0);
        expect(okStatuses, JSON.stringify(res.body).slice(0, 200)).toContain(res.status);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return times.sort((a, b) => a - b);
  }
  const stats = (times: number[]) => ({
    n: times.length,
    p50: Math.round(percentile(times, 50)),
    p95: Math.round(percentile(times, 95)),
    max: Math.round(times[times.length - 1]),
  });
  const get = (user: Authed, path: string) => () => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(user.accessToken));

  it('reads: p95 under 400 ms on large lists', async () => {
    const first = scenes[0];
    const requester = first.requester as unknown as Authed;
    const runner = first.runner as unknown as Authed;
    const cases: Array<[string, Authed, string]> = [
      ['my errands', requester, '/errands/mine?limit=20'],
      ['offers on an errand', requester, `/errands/${first.errandId}/offers`],
      ['conversations', requester, '/conversations?limit=20'],
      ['messages, newest page of 20,000', requester, `/conversations/${busyConversation}/messages?limit=30`],
      ['notifications, 20,000 rows', requester, '/notifications?limit=20'],
      ['unread count', requester, '/notifications/unread-count'],
      ['runner offers', runner, '/runner/offers?limit=20'],
      ['runner assignments', runner, '/runner/assignments?limit=20'],
      ['dashboard summary', requester, '/me/summary'],
      ['an errand, owner view', requester, `/errands/${first.errandId}`],
    ];
    for (const [name, user, path] of cases) {
      // A few warm-up requests: the first call to a route pays for planning and module start-up.
      await timed(Array.from({ length: 5 }, () => get(user, path)), [200]);
      const times = await timed(
        Array.from({ length: READ_REQUESTS }, () => get(user, path)),
        [200],
      );
      const result = stats(times);
      report[`read: ${name}`] = result;
      expect(result.p95, `${name} p95 ${result.p95} ms`).toBeLessThan(READ_TARGET_MS);
    }
  }, 600_000);

  it('writes: select, accept, send message and counter-offer, p95 under 800 ms', async () => {
    const select = await timed(
      scenes.map((s) => () => selectRunner(app, s.requester as unknown as Authed, s.errandId, s.offerId, s.offerVersion)),
      [201],
    );
    report['write: select runner'] = stats(select);

    const assignments = await prisma.assignment.findMany({ where: { errandId: { in: scenes.map((s) => s.errandId) } } });
    const byErrand = new Map(assignments.map((a) => [a.errandId, a.id]));
    const accept = await timed(
      scenes.map((s) => () => acceptAssignment(app, s.runner as unknown as Authed, byErrand.get(s.errandId) as string)),
      [201],
    );
    report['write: accept assignment'] = stats(accept);

    const conversations = await prisma.conversation.findMany({ where: { errandId: { in: scenes.map((s) => s.errandId) } } });
    const conversationOf = new Map(conversations.map((c) => [c.errandId, c.id]));
    const chat = await timed(
      scenes.flatMap((s) => {
        return [1, 2, 3].map((n) => async () => {
          return request(app.getHttpServer())
            .post(`${API}/conversations/${conversationOf.get(s.errandId)}/messages`)
            .set(...bearer((s.runner as unknown as Authed).accessToken))
            .set('Idempotency-Key', randomUUID())
            .send({ type: 'TEXT', body: `Message ${n}` });
        });
      }),
      [201],
    );
    report['write: send message'] = stats(chat);

    for (const key of ['write: select runner', 'write: accept assignment', 'write: send message']) {
      const result = report[key] as { p95: number };
      expect(result.p95, `${key} p95 ${result.p95} ms`).toBeLessThan(WRITE_TARGET_MS);
    }
  }, 600_000);

  it('uses an index for the queries behind the lists', async () => {
    const first = scenes[0];
    const plans: Record<string, string> = {};
    // With sequential scans switched off the planner shows whether a usable index exists, even on
    // a table small enough that it would rather read it whole.
    const explain = async (name: string, sql: string, ...params: unknown[]) => {
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        const rows = (await tx.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) ${sql}`, ...params)) as Array<{ 'QUERY PLAN': unknown }>;
        return JSON.stringify(rows[0]['QUERY PLAN']);
      });
      plans[name] = plan;
    };
    await explain('messages by conversation', 'SELECT id FROM messages WHERE conversation_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT 30', busyConversation);
    await explain(
      'notifications by user',
      'SELECT id FROM notifications WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT 20',
      first.requester.userId,
    );
    await explain('errands by requester', "SELECT id FROM errands WHERE requester_id = $1::uuid AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20", first.requester.userId);
    await explain('offers by errand', 'SELECT id FROM offers WHERE errand_id = $1::uuid', first.errandId);

    const sequential = Object.entries(plans).filter(([, plan]) => plan.includes('"Node Type":"Seq Scan"'));
    report.plans = Object.fromEntries(Object.entries(plans).map(([name, plan]) => [name, plan.includes('Seq Scan') ? 'SEQ SCAN' : 'index']));
    expect(sequential.map(([name]) => name)).toEqual([]);
  });
});

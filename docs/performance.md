# Performance record (Phase 12)

Measured on a developer laptop (8 logical CPUs, Docker Desktop, PostgreSQL 17 and Redis in containers, API in-process under vitest). Targets are from Backend PRD 33.1 at launch scale with 10x headroom. Times are milliseconds from request sent to response read, through the real HTTP stack.

Re-run with:

```bash
RUN_PERF=1 PERF_REPORT=perf-critical.json npx vitest run --config ./vitest.config.int.ts src/perf
RUN_PERF=1 PERF_REPORT=perf-feed.json npx vitest run --config ./vitest.config.int.ts src/marketplace/feed.performance
```

## Critical paths

Data: 5,000 users, 20,000 open errands, one conversation with 20,000 messages, one user with 20,000 notifications. Four requests in flight at once.

| Operation | Requests | p50 | p95 | max | Target p95 |
|---|---|---|---|---|---|
| my errands | 80 | 39 | 45 | 48 | < 400 |
| offers on an errand | 80 | 47 | 67 | 1090 | < 400 |
| conversations | 80 | 54 | 66 | 80 | < 400 |
| messages, newest page of 20,000 | 80 | 42 | 50 | 56 | < 400 |
| notifications, 20,000 rows | 80 | 29 | 36 | 40 | < 400 |
| unread count | 80 | 36 | 49 | 60 | < 400 |
| runner offers | 80 | 31 | 40 | 42 | < 400 |
| runner assignments | 80 | 27 | 33 | 41 | < 400 |
| dashboard summary | 80 | 30 | 37 | 42 | < 400 |
| an errand, owner view | 80 | 47 | 56 | 73 | < 400 |
| select runner | 24 | 143 | 227 | 234 | < 800 |
| accept assignment | 24 | 98 | 109 | 115 | < 800 |
| send message | 72 | 57 | 687 | 1219 | < 800 |

Queries behind the lists (messages by conversation, notifications by user, errands by requester, offers by errand) all use an index (`EXPLAIN`, sequential scans disabled to show whether a usable index exists).

## Marketplace feed

50,000 errands (60% open) over a 40 km box, 120 requests per case, one at a time.

| Request | Items | p50 | p95 | max | Target p95 |
|---|---|---|---|---|---|
| nearest, first page | 20 | 46 | 58 | 141 | < 600 |
| newest, first page | 20 | 44 | 72 | 114 | < 600 |
| filtered by category and budget | 20 | 40 | 50 | 63 | < 600 |
| search "cake" | 20 | 59 | 83 | 134 | < 600 |
| search by area "Area 7" | 20 | 54 | 120 | 236 | < 600 |
| narrowed to 2 km | 20 | 31 | 38 | 95 | < 600 |
| map | 100 | 45 | 61 | 127 | < 600 |
| nearest, 9th page | 20 | 44 | 53 | 71 | < 600 |
| 20 km area, nearest | 20 | 289 | 349 | 370 | < 600 |
| 20 km area, newest | 20 | 267 | 512 | 726 | < 600 |

## Deviations and things to watch

- **No target is missed.** The closest is the feed at the widest area (20 km, newest first): p95 about half a second against 600 ms. It reads about 22,000 candidate rows before it sorts. If real volume nears the 10x headroom, narrow the default radius or add a cached first page per area before adding hardware.
- **Messages in one conversation are serialised** by a row lock, by design (read receipts and ordering). Three messages sent at once to the same conversation show a tail near the target; one conversation never sees that rate in practice.
- **Connection pool.** The Prisma default (2 x CPU + 1 connections per process) held at four requests in flight. Set `connection_limit` on `DATABASE_URL` per process in production so that API + worker + scheduler stay under PostgreSQL `max_connections`.
- **Single-run outliers.** A first request after start-up can take 1 s (planning, module warm-up). The measured runs warm each route first.
- **Local setup note.** On Windows with Docker Desktop, use `127.0.0.1` rather than `localhost` in `DATABASE_URL` and `REDIS_URL`: `localhost` resolves to IPv6 first and the forwarded port intermittently refused connections under load (`Can't reach database server`).

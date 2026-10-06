/**
 * Test environment resolution.
 *
 * Integration and e2e tests never touch the development database or Redis.
 * They run against `<database>_test` (created on demand) and Redis database 15,
 * and every destructive helper refuses to run against anything else.
 */

import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const TEST_REDIS_DB = 15;

export interface TestEnv {
  databaseUrl: string;
  databaseName: string;
  /** Connection to the server's `postgres` database, used to create the test database. */
  adminDatabaseUrl: string;
  redisUrl: string;
}

export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(name)}`;
  return parsed.toString();
}

function redisDbOf(url: string): number {
  const path = new URL(url).pathname.replace(/^\//, '');
  return path === '' ? 0 : Number.parseInt(path, 10);
}

function withRedisDb(url: string, db: number): string {
  const parsed = new URL(url);
  parsed.pathname = `/${db}`;
  return parsed.toString();
}

/**
 * Work out the test database and Redis URLs from `.env`. Idempotent: calling it
 * again after `applyTestEnv` returns the same values.
 */
export function resolveTestEnv(): TestEnv {
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) {
    loadDotenv({ path: envFile, override: false, quiet: true });
  }

  const explicit = process.env.DATABASE_URL_TEST;
  const base = process.env.DATABASE_URL;
  if (!explicit && !base) {
    throw new Error(
      'Set DATABASE_URL (or DATABASE_URL_TEST) to run integration tests.',
    );
  }

  const baseName = base ? databaseNameOf(base) : '';
  const databaseUrl =
    explicit ??
    (baseName.endsWith('_test')
      ? (base as string)
      : withDatabaseName(base as string, `${baseName}_test`));
  const databaseName = databaseNameOf(databaseUrl);

  const redisUrl =
    process.env.REDIS_URL_TEST ??
    withRedisDb(process.env.REDIS_URL ?? 'redis://localhost:6379', TEST_REDIS_DB);

  return {
    databaseUrl,
    databaseName,
    adminDatabaseUrl: withDatabaseName(databaseUrl, 'postgres'),
    redisUrl,
  };
}

/**
 * Point this process at the test database and test Redis. Must run before the
 * app or any helper reads DATABASE_URL / REDIS_URL.
 */
export function applyTestEnv(): TestEnv {
  const env = resolveTestEnv();
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = env.databaseUrl;
  process.env.REDIS_URL = env.redisUrl;
  return env;
}

/** Refuse to run destructive helpers unless the database name ends in `_test`. */
export function assertSafeTestDatabase(url = process.env.DATABASE_URL): void {
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  const name = databaseNameOf(url);
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run: "${name}" is not a test database (its name must end with "_test"). ` +
        'Integration tests must run through the test configs so applyTestEnv() is used.',
    );
  }
}

/** Refuse to flush Redis database 0 (the development database). */
export function assertSafeTestRedis(url = process.env.REDIS_URL): void {
  if (!url) {
    throw new Error('REDIS_URL is not set');
  }
  if (redisDbOf(url) === 0) {
    throw new Error(
      'Refusing to run: REDIS_URL points at Redis database 0. Tests must use a separate Redis database.',
    );
  }
}

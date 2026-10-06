import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTestEnv,
  assertSafeTestDatabase,
  assertSafeTestRedis,
  databaseNameOf,
  resolveTestEnv,
} from './test-env.js';

const KEYS = [
  'DATABASE_URL',
  'DATABASE_URL_TEST',
  'REDIS_URL',
  'REDIS_URL_TEST',
  'NODE_ENV',
] as const;

describe('test environment safety', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    delete process.env.DATABASE_URL_TEST;
    delete process.env.REDIS_URL_TEST;
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('derives a separate *_test database from the development URL', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5544/urgent_ng?schema=public';

    const env = resolveTestEnv();

    expect(env.databaseName).toBe('urgent_ng_test');
    expect(env.databaseUrl).toContain('/urgent_ng_test');
    expect(env.databaseUrl).toContain('schema=public');
    expect(env.adminDatabaseUrl).toContain('/postgres');
  });

  it('is idempotent: applying twice does not append _test twice', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5544/urgent_ng';

    applyTestEnv();
    const second = applyTestEnv();

    expect(second.databaseName).toBe('urgent_ng_test');
    expect(databaseNameOf(process.env.DATABASE_URL as string)).toBe('urgent_ng_test');
  });

  it('prefers an explicit DATABASE_URL_TEST', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5544/urgent_ng';
    process.env.DATABASE_URL_TEST = 'postgresql://u:p@localhost:5544/custom_test';

    expect(resolveTestEnv().databaseName).toBe('custom_test');
  });

  it('moves Redis to database 15', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5544/urgent_ng';
    process.env.REDIS_URL = 'redis://localhost:6399';

    expect(resolveTestEnv().redisUrl).toBe('redis://localhost:6399/15');
  });

  it('refuses destructive helpers on a non-test database', () => {
    expect(() =>
      assertSafeTestDatabase('postgresql://u:p@localhost:5544/urgent_ng'),
    ).toThrow('not a test database');
    expect(() =>
      assertSafeTestDatabase('postgresql://u:p@localhost:5544/urgent_ng_test'),
    ).not.toThrow();
  });

  it('refuses to flush Redis database 0', () => {
    expect(() => assertSafeTestRedis('redis://localhost:6399')).toThrow('database 0');
    expect(() => assertSafeTestRedis('redis://localhost:6399/0')).toThrow('database 0');
    expect(() => assertSafeTestRedis('redis://localhost:6399/15')).not.toThrow();
  });
});

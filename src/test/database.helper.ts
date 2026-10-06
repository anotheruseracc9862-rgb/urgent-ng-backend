/**
 * Test database helper for integration tests.
 * Every helper refuses to run unless it is pointed at the test database
 * (`*_test`) and a non-zero Redis database.
 */

import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { assertSafeTestDatabase, assertSafeTestRedis } from './test-env.js';

let prisma: PrismaClient | null = null;
let redis: Redis | null = null;

// Tables that belong to Prisma or to PostGIS and must never be truncated.
const PROTECTED_TABLES = ['_prisma_migrations', 'spatial_ref_sys'];

/**
 * Get or create shared Prisma client for tests
 */
export function getTestPrisma(): PrismaClient {
  assertSafeTestDatabase();
  if (!prisma) {
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
    });
  }
  return prisma;
}

/**
 * Get or create shared Redis client for tests
 */
export function getTestRedis(): Redis {
  assertSafeTestRedis();
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: null,
    });
  }
  return redis;
}

/**
 * Remove all rows from every application table (for test cleanup).
 * Keeps table structure. Runs as one statement, so it works on a pooled
 * connection, and never touches Prisma or PostGIS system tables.
 */
export async function cleanDatabase(): Promise<void> {
  const client = getTestPrisma();

  const tables = await client.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
  `;

  const names = tables
    .map((table) => table.tablename)
    .filter((name) => !PROTECTED_TABLES.includes(name));

  if (names.length === 0) {
    return;
  }

  const list = names.map((name) => `"${name}"`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Flush all keys from the test Redis database
 */
export async function cleanRedis(): Promise<void> {
  const client = getTestRedis();
  await client.flushdb();
}

/**
 * Clean both database and Redis
 */
export async function cleanAll(): Promise<void> {
  await Promise.all([cleanDatabase(), cleanRedis()]);
}

/**
 * Close all test database connections
 */
export async function closeTestConnections(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }

  if (redis) {
    await redis.quit();
    redis = null;
  }
}

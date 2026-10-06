/**
 * Test database helper for integration tests
 * Manages database lifecycle, cleanup, and transaction rollback per test
 */

import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';

let prisma: PrismaClient | null = null;
let redis: Redis | null = null;

/**
 * Get or create shared Prisma client for tests
 */
export function getTestPrisma(): PrismaClient {
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
  if (!redis) {
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6399', 10),
      db: parseInt(process.env.REDIS_DB || '0', 10),
      maxRetriesPerRequest: null,
    });
  }
  return redis;
}

/**
 * Clean all tables in the database (for test cleanup)
 * Preserves structure, only deletes data
 */
export async function cleanDatabase(): Promise<void> {
  const client = getTestPrisma();
  
  // Get all table names from the database
  const tables = await client.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables 
    WHERE schemaname = 'public' 
    AND tablename != '_prisma_migrations'
  `;

  // Disable triggers and truncate all tables
  await client.$executeRawUnsafe('SET session_replication_role = replica;');
  
  for (const { tablename } of tables) {
    await client.$executeRawUnsafe(`TRUNCATE TABLE "${tablename}" CASCADE;`);
  }
  
  await client.$executeRawUnsafe('SET session_replication_role = DEFAULT;');
}

/**
 * Flush all keys from test Redis database
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
 * Call this in global teardown
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

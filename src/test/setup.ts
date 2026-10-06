/**
 * Global setup for integration and e2e tests. Runs once before all tests:
 * creates the `<database>_test` database if needed and applies the committed
 * migrations to it (never to the development database).
 */

import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { applyTestEnv, TestEnv } from './test-env.js';

async function ensureDatabase(env: TestEnv): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(env.databaseName)) {
    throw new Error(`Unsafe test database name: ${env.databaseName}`);
  }

  const admin = new PrismaClient({
    datasources: { db: { url: env.adminDatabaseUrl } },
  });
  try {
    const existing = await admin.$queryRawUnsafe<Array<{ one: number }>>(
      `SELECT 1 AS one FROM pg_database WHERE datname = '${env.databaseName}'`,
    );
    if (existing.length === 0) {
      console.log(`Creating test database ${env.databaseName}...`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${env.databaseName}"`);
    }
  } finally {
    await admin.$disconnect();
  }
}

export async function setup(): Promise<void> {
  const env = applyTestEnv();
  await ensureDatabase(env);

  console.log(`Applying migrations to ${env.databaseName}...`);
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: env.databaseUrl },
  });

}

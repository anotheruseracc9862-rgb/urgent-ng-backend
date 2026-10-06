/**
 * Integration test demonstrating real database test harness
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTestPrisma,
  getTestRedis,
  cleanDatabase,
  cleanRedis,
  cleanAll,
} from './database.helper.js';

describe('Database Test Harness (Integration)', () => {
  beforeEach(async () => {
    // Clean before each test to ensure isolation
    await cleanAll();
  });

  describe('Prisma client', () => {
    it('should connect to test database', async () => {
      const prisma = getTestPrisma();
      
      // Query should work (no tables with data yet, but connection works)
      const result = await prisma.$queryRaw<Array<{ current_database: string }>>`
        SELECT current_database()
      `;
      
      expect(result).toHaveLength(1);
      // Integration tests must never run against the development database
      expect(result[0].current_database.endsWith('_test')).toBe(true);
    });

    it('should insert and read data from database', async () => {
      const prisma = getTestPrisma();
      
      // Since we have no models yet, test with raw SQL
      // Create a test table
      await prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS test_users (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      
      // Insert test data
      await prisma.$executeRaw`
        INSERT INTO test_users (name, email) 
        VALUES ('Test User', 'test@example.com')
      `;
      
      // Read it back
      const users = await prisma.$queryRaw<Array<{ id: number; name: string; email: string }>>`
        SELECT id, name, email FROM test_users
      `;
      
      expect(users).toHaveLength(1);
      expect(users[0].name).toBe('Test User');
      expect(users[0].email).toBe('test@example.com');
      
      // Clean up the test table
      await prisma.$executeRaw`DROP TABLE IF EXISTS test_users`;
    });
  });

  describe('Redis client', () => {
    it('should connect to test Redis', async () => {
      const redis = getTestRedis();
      
      const pong = await redis.ping();
      expect(pong).toBe('PONG');
    });

    it('should set and get values from Redis', async () => {
      const redis = getTestRedis();
      
      await redis.set('test:key', 'test-value');
      const value = await redis.get('test:key');
      
      expect(value).toBe('test-value');
    });
  });

  describe('Database cleanup', () => {
    it('should clean all tables', async () => {
      const prisma = getTestPrisma();
      
      // Create and populate test table
      await prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS test_cleanup (
          id SERIAL PRIMARY KEY,
          data TEXT
        )
      `;
      
      await prisma.$executeRaw`
        INSERT INTO test_cleanup (data) VALUES ('test1'), ('test2'), ('test3')
      `;
      
      // Verify data exists
      const before = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM test_cleanup
      `;
      expect(Number(before[0].count)).toBe(3);
      
      // Clean database
      await cleanDatabase();
      
      // Verify data is gone but table structure remains
      const after = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM test_cleanup
      `;
      expect(Number(after[0].count)).toBe(0);
      
      // Clean up test table
      await prisma.$executeRaw`DROP TABLE IF EXISTS test_cleanup`;
    });
  });

  describe('Redis cleanup', () => {
    it('should flush all Redis keys', async () => {
      const redis = getTestRedis();
      
      // Set multiple keys
      await redis.set('test:key1', 'value1');
      await redis.set('test:key2', 'value2');
      await redis.set('test:key3', 'value3');
      
      // Verify keys exist
      const keysBefore = await redis.keys('test:*');
      expect(keysBefore.length).toBeGreaterThanOrEqual(3);
      
      // Clean Redis
      await cleanRedis();
      
      // Verify all keys are gone
      const keysAfter = await redis.keys('*');
      expect(keysAfter).toHaveLength(0);
    });
  });

  describe('Test isolation', () => {
    it('first test should not see data from other tests', async () => {
      const prisma = getTestPrisma();
      const redis = getTestRedis();
      
      // Create test table and insert data
      await prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS test_isolation (
          id SERIAL PRIMARY KEY,
          value TEXT
        )
      `;
      await prisma.$executeRaw`
        INSERT INTO test_isolation (value) VALUES ('test-data')
      `;
      
      // Set Redis key
      await redis.set('isolation:test', 'data');
      
      // Verify data exists
      const dbData = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM test_isolation
      `;
      expect(Number(dbData[0].count)).toBe(1);
      
      const redisData = await redis.get('isolation:test');
      expect(redisData).toBe('data');
      
      // Clean up
      await prisma.$executeRaw`DROP TABLE IF EXISTS test_isolation`;
    });

    it('second test should start with clean state', async () => {
      const redis = getTestRedis();
      
      // Redis should be empty (cleaned by beforeEach)
      const keys = await redis.keys('isolation:*');
      expect(keys).toHaveLength(0);
      
      // No leftover test tables from previous test
      const prisma = getTestPrisma();
      const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
        SELECT tablename FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename = 'test_isolation'
      `;
      
      // Table should not exist (was dropped in previous test)
      expect(tables).toHaveLength(0);
    });
  });
});

/**
 * Migration patterns integration tests (P1-01)
 * Tests all migration patterns demonstrated in pattern_migration_patterns:
 * - Geography column with GiST spatial index
 * - Partial unique indexes for soft-deletable tables
 * - CHECK constraints
 * - Generated tsvector with GIN full-text index
 * - Row locking with FOR UPDATE
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getTestPrisma, cleanDatabase } from '../test/database.helper.js';
import { lockRow, lockRows } from './lock-row.helper.js';

describe('Migration Patterns (Integration)', () => {
  const prisma = getTestPrisma();

  beforeAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS pattern_locations, pattern_constraints');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE pattern_locations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        description TEXT,
        location GEOGRAPHY(Point, 4326) NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        search_vector TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(description, '')), 'B')
        ) STORED,
        CONSTRAINT pattern_locations_deleted_at_not_future_check
          CHECK (deleted_at IS NULL OR deleted_at <= NOW())
      )
    `);
    await prisma.$executeRawUnsafe('CREATE INDEX pattern_locations_location_gist_idx ON pattern_locations USING GIST(location)');
    await prisma.$executeRawUnsafe('CREATE INDEX pattern_locations_search_gin_idx ON pattern_locations USING GIN(search_vector)');
    await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX pattern_locations_name_unique_idx ON pattern_locations(name) WHERE deleted_at IS NULL');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE pattern_constraints (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'COMPLETED')),
        amount_kobo BIGINT NOT NULL CHECK (amount_kobo >= 0),
        percentage INTEGER CHECK (percentage >= 0 AND percentage <= 100),
        completed_at TIMESTAMPTZ,
        completion_reason TEXT,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT pattern_constraints_completed_at_required_check CHECK (
          (status = 'COMPLETED' AND completed_at IS NOT NULL) OR
          (status != 'COMPLETED' AND completed_at IS NULL)
        ),
        CONSTRAINT pattern_constraints_completion_reason_required_check CHECK (
          (status = 'COMPLETED' AND completion_reason IS NOT NULL) OR
          (status != 'COMPLETED')
        )
      )
    `);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS pattern_locations, pattern_constraints');
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  describe('Geography column with GiST spatial index', () => {
    it('should store and query geography points', async () => {
      // Insert a location (Lagos coordinates)
      await prisma.$executeRaw`
        INSERT INTO pattern_locations (name, description, location, status)
        VALUES (
          'Test Location',
          'A test location in Lagos',
          ST_GeogFromText('POINT(3.3792 6.5244)'),
          'ACTIVE'
        )
      `;

      // Query locations within 10km radius
      const nearby = await prisma.$queryRaw<Array<{ name: string; distance: number }>>`
        SELECT 
          name,
          ST_Distance(location, ST_GeogFromText('POINT(3.3800 6.5250)')) as distance
        FROM pattern_locations
        WHERE ST_DWithin(
          location,
          ST_GeogFromText('POINT(3.3800 6.5250)'),
          10000
        )
        ORDER BY distance
      `;

      expect(nearby).toHaveLength(1);
      expect(nearby[0].name).toBe('Test Location');
      expect(nearby[0].distance).toBeLessThan(10000);
    });

    it('should use GiST index for spatial queries', async () => {
      // Verify index exists
      const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname 
        FROM pg_indexes 
        WHERE tablename = 'pattern_locations' 
        AND indexname = 'pattern_locations_location_gist_idx'
      `;

      expect(indexes).toHaveLength(1);
    });
  });

  describe('Partial unique index for soft-deletable tables', () => {
    it('should allow same name after soft deletion', async () => {
      const name = 'Duplicate Name';

      // Insert first record
      await prisma.$executeRaw`
        INSERT INTO pattern_locations (name, location, status)
        VALUES (${name}, ST_GeogFromText('POINT(3.3792 6.5244)'), 'ACTIVE')
      `;

      // Soft delete it
      await prisma.$executeRaw`
        UPDATE pattern_locations 
        SET deleted_at = NOW() 
        WHERE name = ${name}
      `;

      // Insert second record with same name - should succeed
      await prisma.$executeRaw`
        INSERT INTO pattern_locations (name, location, status)
        VALUES (${name}, ST_GeogFromText('POINT(3.3800 6.5250)'), 'ACTIVE')
      `;

      const count = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM pattern_locations WHERE name = ${name}
      `;

      expect(Number(count[0].count)).toBe(2);
    });

    it('should reject duplicate names among non-deleted rows', async () => {
      const name = 'Unique Name';

      // Insert first record
      await prisma.$executeRaw`
        INSERT INTO pattern_locations (name, location, status)
        VALUES (${name}, ST_GeogFromText('POINT(3.3792 6.5244)'), 'ACTIVE')
      `;

      // Try to insert duplicate - should fail
      await expect(
        prisma.$executeRaw`
          INSERT INTO pattern_locations (name, location, status)
          VALUES (${name}, ST_GeogFromText('POINT(3.3800 6.5250)'), 'ACTIVE')
        `,
      ).rejects.toThrow(/already exists/i);
    });
  });

  describe('CHECK constraints', () => {
    it('should reject invalid status values', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO pattern_locations (name, location, status)
          VALUES ('Test', ST_GeogFromText('POINT(3.3792 6.5244)'), 'INVALID')
        `,
      ).rejects.toThrow(/violates check constraint/i);
    });

    it('should reject negative amounts', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO pattern_constraints (status, amount_kobo, percentage)
          VALUES ('ACTIVE', -100, 50)
        `,
      ).rejects.toThrow(/violates check constraint/i);
    });

    it('should reject percentage outside 0-100', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO pattern_constraints (status, amount_kobo, percentage)
          VALUES ('ACTIVE', 1000, 150)
        `,
      ).rejects.toThrow(/violates check constraint/i);
    });

    it('should enforce status-dependent field requirements', async () => {
      // COMPLETED status requires completed_at
      await expect(
        prisma.$executeRaw`
          INSERT INTO pattern_constraints (status, amount_kobo)
          VALUES ('COMPLETED', 1000)
        `,
      ).rejects.toThrow(/violates check constraint/i);

      // COMPLETED status requires completion_reason
      await expect(
        prisma.$executeRaw`
          INSERT INTO pattern_constraints (status, amount_kobo, completed_at)
          VALUES ('COMPLETED', 1000, NOW())
        `,
      ).rejects.toThrow(/violates check constraint/i);

      // Valid COMPLETED record
      await prisma.$executeRaw`
        INSERT INTO pattern_constraints (status, amount_kobo, completed_at, completion_reason)
        VALUES ('COMPLETED', 1000, NOW(), 'Finished')
      `;

      const count = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM pattern_constraints WHERE status = 'COMPLETED'
      `;

      expect(Number(count[0].count)).toBe(1);
    });

    it('should reject future deleted_at timestamps', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO pattern_locations (name, location, status, deleted_at)
          VALUES (
            'Future Deleted',
            ST_GeogFromText('POINT(3.3792 6.5244)'),
            'ACTIVE',
            NOW() + INTERVAL '1 day'
          )
        `,
      ).rejects.toThrow(/violates check constraint/i);
    });
  });

  describe('Generated tsvector with GIN full-text index', () => {
    it('should perform full-text search', async () => {
      // Insert test data
      await prisma.$executeRaw`
        INSERT INTO pattern_locations (name, description, location, status)
        VALUES 
          ('Lagos Market', 'A busy market in Lagos', ST_GeogFromText('POINT(3.3792 6.5244)'), 'ACTIVE'),
          ('Ikeja Mall', 'Shopping mall in Ikeja', ST_GeogFromText('POINT(3.3500 6.6000)'), 'ACTIVE'),
          ('Victoria Island Office', 'Commercial office space', ST_GeogFromText('POINT(3.4200 6.4300)'), 'ACTIVE')
      `;

      // Search for "market"
      const results = await prisma.$queryRaw<Array<{ name: string; rank: number }>>`
        SELECT name, ts_rank(search_vector, query) as rank
        FROM pattern_locations, to_tsquery('english', 'market') query
        WHERE search_vector @@ query
        ORDER BY rank DESC
      `;

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Lagos Market');
    });

    it('should use GIN index for full-text search', async () => {
      // Verify index exists
      const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname 
        FROM pg_indexes 
        WHERE tablename = 'pattern_locations' 
        AND indexname = 'pattern_locations_search_gin_idx'
      `;

      expect(indexes).toHaveLength(1);
    });
  });

  describe('Row locking with FOR UPDATE', () => {
    it('should lock a single row', async () => {
      // Insert test data
      const result = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO pattern_locations (name, location, status)
        VALUES ('Lock Test', ST_GeogFromText('POINT(3.3792 6.5244)'), 'ACTIVE')
        RETURNING id
      `;

      const id = result[0].id;

      // Lock the row in a transaction (exclude geography column)
      await prisma.$transaction(async (tx) => {
        const locked = await lockRow<{ id: string; name: string; status: string }>(
          tx,
          'pattern_locations',
          id,
          'id, name, status',
        );

        expect(locked).not.toBeNull();
        expect(locked?.id).toBe(id);
        expect(locked?.name).toBe('Lock Test');
      });
    });

    it('should lock multiple rows', async () => {
      // Insert test data
      await prisma.$executeRaw`
        INSERT INTO pattern_locations (name, location, status)
        VALUES 
          ('Lock Test 1', ST_GeogFromText('POINT(3.3792 6.5244)'), 'ACTIVE'),
          ('Lock Test 2', ST_GeogFromText('POINT(3.3800 6.5250)'), 'ACTIVE')
      `;

      const ids = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM pattern_locations WHERE name LIKE 'Lock Test%'
      `;

      expect(ids).toHaveLength(2);

      // Lock multiple rows (exclude geography column)
      await prisma.$transaction(async (tx) => {
        const locked = await lockRows<{ id: string; name: string }>(
          tx,
          'pattern_locations',
          ids.map((r) => r.id),
          'id, name',
        );

        expect(locked).toHaveLength(2);
      });
    });

    it('should return null for non-existent row', async () => {
      await prisma.$transaction(async (tx) => {
        const locked = await lockRow(
          tx,
          'pattern_locations',
          '00000000-0000-0000-0000-000000000000',
          'id',
        );

        expect(locked).toBeNull();
      });
    });
  });

  describe('Migration deployment to empty database', () => {
    it('creates the Phase 1 tables, drops the demo tables and enables PostGIS', async () => {
      const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `;
      const names = tables.map((table) => table.tablename);

      for (const expected of [
        'audit_logs',
        'outbox_events',
        'idempotency_keys',
        'config_values',
        'commercial_products',
        'price_versions',
      ]) {
        expect(names).toContain(expected);
      }
      expect(names).not.toContain('demo_locations');
      expect(names).not.toContain('demo_constraints');

      const extensions = await prisma.$queryRaw<Array<{ extname: string }>>`
        SELECT extname FROM pg_extension WHERE extname = 'postgis'
      `;
      expect(extensions).toHaveLength(1);
    });
  });

  describe('uuid_generate_v7()', () => {
    it('returns version-7 UUIDs that sort by creation time', async () => {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT uuid_generate_v7()::text AS id FROM generate_series(1, 50)
      `;
      const ids = rows.map((row) => row.id);

      for (const id of ids) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
      expect(new Set(ids).size).toBe(50);

      // the first 48 bits are the millisecond timestamp, so they never go backwards
      const prefixes = ids.map((id) => id.replace('-', '').slice(0, 12));
      expect([...prefixes].sort()).toEqual(prefixes);

      // ids created in different milliseconds sort in creation order
      const [first] = await prisma.$queryRaw<Array<{ id: string }>>`SELECT uuid_generate_v7()::text AS id`;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const [second] = await prisma.$queryRaw<Array<{ id: string }>>`SELECT uuid_generate_v7()::text AS id`;
      expect(first.id < second.id).toBe(true);
    });

    it('is the id default of the Phase 1 tables', async () => {
      const defaults = await prisma.$queryRaw<Array<{ table_name: string; column_default: string }>>`
        SELECT table_name, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'id'
          AND table_name IN ('audit_logs', 'outbox_events', 'idempotency_keys',
                             'config_values', 'commercial_products', 'price_versions')
      `;

      expect(defaults).toHaveLength(6);
      for (const row of defaults) {
        expect(row.column_default).toContain('uuid_generate_v7');
      }
    });
  });
});

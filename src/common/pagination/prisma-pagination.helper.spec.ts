import { describe, it, expect } from 'vitest';
import {
  buildPrismaWhere,
  buildPrismaOrderBy,
} from './prisma-pagination.helper.js';

describe('Prisma Pagination Helpers', () => {
  describe('buildPrismaWhere', () => {
    it('should return empty object when no cursor', () => {
      const where = buildPrismaWhere({
        limit: 20,
        sortField: 'score',
      });

      expect(where).toEqual({});
    });

    it('should build OR clause for ascending sort', () => {
      const cursor = {
        sort: 100,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        id: 'abc123',
      };

      const where = buildPrismaWhere({
        cursor,
        limit: 20,
        sortField: 'score',
        sortDirection: 'asc',
      });

      expect(where).toEqual({
        OR: [
          { score: { gt: 100 } },
          {
            AND: [
              { score: 100 },
              { createdAt: { gt: cursor.createdAt } },
            ],
          },
          {
            AND: [
              { score: 100 },
              { createdAt: cursor.createdAt },
              { id: { gt: 'abc123' } },
            ],
          },
        ],
      });
    });

    it('should build OR clause for descending sort', () => {
      const cursor = {
        sort: 100,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        id: 'abc123',
      };

      const where = buildPrismaWhere({
        cursor,
        limit: 20,
        sortField: 'score',
        sortDirection: 'desc',
      });

      expect(where).toEqual({
        OR: [
          { score: { lt: 100 } },
          {
            AND: [
              { score: 100 },
              { createdAt: { lt: cursor.createdAt } },
            ],
          },
          {
            AND: [
              { score: 100 },
              { createdAt: cursor.createdAt },
              { id: { lt: 'abc123' } },
            ],
          },
        ],
      });
    });
  });

  describe('buildPrismaOrderBy', () => {
    it('should build orderBy array for ascending sort', () => {
      const orderBy = buildPrismaOrderBy('score', 'asc');

      expect(orderBy).toEqual([
        { score: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
    });

    it('should build orderBy array for descending sort', () => {
      const orderBy = buildPrismaOrderBy('score', 'desc');

      expect(orderBy).toEqual([
        { score: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
    });

    it('should default to ascending', () => {
      const orderBy = buildPrismaOrderBy('score');

      expect(orderBy).toEqual([
        { score: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
    });
  });
});

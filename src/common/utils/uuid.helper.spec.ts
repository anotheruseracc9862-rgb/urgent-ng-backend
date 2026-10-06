import { describe, it, expect } from 'vitest';
import { generateUuidV7, generateUuid } from './uuid.helper.js';

describe('UUID Helpers', () => {
  describe('generateUuidV7', () => {
    it('should generate valid UUIDv7', () => {
      const uuid = generateUuidV7();
      
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('should generate time-ordered UUIDs', () => {
      const uuid1 = generateUuidV7();
      const uuid2 = generateUuidV7();
      
      // UUIDv7 should be sortable by time
      expect(uuid1.localeCompare(uuid2)).toBeLessThanOrEqual(0);
    });

    it('should generate unique UUIDs', () => {
      const uuids = new Set();
      for (let i = 0; i < 1000; i++) {
        uuids.add(generateUuidV7());
      }
      
      expect(uuids.size).toBe(1000);
    });
  });

  describe('generateUuid', () => {
    it('should generate valid UUIDv4', () => {
      const uuid = generateUuid();
      
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('should generate unique UUIDs', () => {
      const uuids = new Set();
      for (let i = 0; i < 1000; i++) {
        uuids.add(generateUuid());
      }
      
      expect(uuids.size).toBe(1000);
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  generateUuidV7,
  generateUuid,
  uuidV7Timestamp,
} from './uuid.helper.js';

describe('UUID Helpers', () => {
  describe('generateUuidV7', () => {
    it('should generate a valid RFC 9562 UUIDv7 (version 7, variant 10xx)', () => {
      const uuid = generateUuidV7();

      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('should encode the real millisecond timestamp', () => {
      const before = Date.now();
      const uuid = generateUuidV7();
      const after = Date.now();

      const encoded = uuidV7Timestamp(uuid);
      expect(encoded).toBeGreaterThanOrEqual(before);
      expect(encoded).toBeLessThanOrEqual(after);
    });

    it('should sort in creation order, even within one millisecond', () => {
      const ids = Array.from({ length: 2000 }, () => generateUuidV7());
      const sorted = [...ids].sort();

      expect(sorted).toEqual(ids);
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

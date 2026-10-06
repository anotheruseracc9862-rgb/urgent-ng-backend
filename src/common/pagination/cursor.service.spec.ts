import { describe, it, expect, beforeEach } from 'vitest';
import { CursorService } from './cursor.service.js';
import { ConfigService } from '@nestjs/config';

describe('CursorService', () => {
  let service: CursorService;
  let configService: ConfigService;

  beforeEach(() => {
    configService = new ConfigService({
      security: { hmacSecret: 'test-secret-key-for-hmac' },
    });
    service = new CursorService(configService);
  });

  describe('encode and decode', () => {
    it('should encode and decode cursor data', () => {
      const data = {
        sort: 100,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        id: '123e4567-e89b-12d3-a456-426614174000',
      };

      const encoded = service.encode(data);
      const decoded = service.decode(encoded);

      expect(decoded.sort).toBe(data.sort);
      expect(decoded.createdAt.toISOString()).toBe(data.createdAt.toISOString());
      expect(decoded.id).toBe(data.id);
    });

    it('should handle string sort values', () => {
      const data = {
        sort: 'test-value',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        id: '123e4567-e89b-12d3-a456-426614174000',
      };

      const encoded = service.encode(data);
      const decoded = service.decode(encoded);

      expect(decoded.sort).toBe(data.sort);
    });

    it('should throw on tampered cursor', () => {
      const data = {
        sort: 100,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        id: '123e4567-e89b-12d3-a456-426614174000',
      };

      const encoded = service.encode(data);
      const tampered = encoded.slice(0, -5) + 'XXXXX';

      expect(() => service.decode(tampered)).toThrow('Invalid cursor');
    });

    it('should throw on invalid base64', () => {
      expect(() => service.decode('not-valid-base64!!!')).toThrow('Invalid cursor');
    });

    it('should throw on malformed JSON', () => {
      const invalid = Buffer.from('not valid json').toString('base64url');
      expect(() => service.decode(invalid)).toThrow('Invalid cursor');
    });
  });

  describe('signature verification', () => {
    it('should detect signature changes', () => {
      const data = {
        sort: 100,
        createdAt: new Date(),
        id: '123e4567-e89b-12d3-a456-426614174000',
      };

      const encoded = service.encode(data);
      const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
      const parsed = JSON.parse(decoded);
      
      // Tamper with signature
      parsed.signature = 'tampered';
      const reencoded = Buffer.from(JSON.stringify(parsed)).toString('base64url');

      expect(() => service.decode(reencoded)).toThrow('Invalid cursor');
    });
  });
});

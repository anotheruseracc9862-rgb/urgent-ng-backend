import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  isValidNigerianPhone,
  hasValidNigerianPrefix,
} from './phone.helper.js';

describe('Phone Helpers', () => {
  describe('normalizePhone', () => {
    it('should normalize 080... format', () => {
      expect(normalizePhone('08012345678')).toBe('+2348012345678');
    });

    it('should normalize 234... format', () => {
      expect(normalizePhone('2348012345678')).toBe('+2348012345678');
    });

    it('should normalize +234... format', () => {
      expect(normalizePhone('+2348012345678')).toBe('+2348012345678');
    });

    it('should handle phone with spaces', () => {
      expect(normalizePhone('080 1234 5678')).toBe('+2348012345678');
    });

    it('should handle phone with dashes', () => {
      expect(normalizePhone('080-1234-5678')).toBe('+2348012345678');
    });

    it('should handle phone with parentheses', () => {
      expect(normalizePhone('(080) 1234-5678')).toBe('+2348012345678');
    });

    it('should handle the country code followed by the national leading 0', () => {
      expect(normalizePhone('+23408012345678')).toBe('+2348012345678');
      expect(normalizePhone('23408012345678')).toBe('+2348012345678');
      expect(normalizePhone('+234 0801 234 5678')).toBe('+2348012345678');
    });

    it('should handle dots', () => {
      expect(normalizePhone('0801.234.5678')).toBe('+2348012345678');
    });

    it('should throw on empty string', () => {
      expect(() => normalizePhone('')).toThrow('required');
    });

    it('should throw on invalid format', () => {
      expect(() => normalizePhone('12345')).toThrow('Invalid Nigerian');
    });

    it('should throw on wrong length', () => {
      expect(() => normalizePhone('0801234567')).toThrow('Invalid Nigerian');
    });

    it('should throw on wrong prefix', () => {
      expect(() => normalizePhone('09912345678')).toThrow('Invalid Nigerian');
    });
  });

  describe('isValidNigerianPhone', () => {
    it('should return true for valid numbers', () => {
      expect(isValidNigerianPhone('08012345678')).toBe(true);
      expect(isValidNigerianPhone('2348012345678')).toBe(true);
      expect(isValidNigerianPhone('+2348012345678')).toBe(true);
    });

    it('should return false for invalid numbers', () => {
      expect(isValidNigerianPhone('12345')).toBe(false);
      expect(isValidNigerianPhone('')).toBe(false);
      expect(isValidNigerianPhone('invalid')).toBe(false);
    });
  });

  describe('hasValidNigerianPrefix', () => {
    it('should accept valid prefixes', () => {
      expect(hasValidNigerianPrefix('07012345678')).toBe(true);
      expect(hasValidNigerianPrefix('08012345678')).toBe(true);
      expect(hasValidNigerianPrefix('08112345678')).toBe(true);
      expect(hasValidNigerianPrefix('09012345678')).toBe(true);
      expect(hasValidNigerianPrefix('09112345678')).toBe(true);
    });

    it('should work with different formats', () => {
      expect(hasValidNigerianPrefix('+2348012345678')).toBe(true);
      expect(hasValidNigerianPrefix('2348012345678')).toBe(true);
    });
  });
});

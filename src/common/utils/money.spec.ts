import { describe, it, expect } from 'vitest';
import { Money } from './money.js';

describe('Money', () => {
  describe('fromKobo', () => {
    it('should create Money from kobo', () => {
      const money = Money.fromKobo(10000);
      expect(money.toKobo()).toBe(10000);
      expect(money.toNaira()).toBe(100);
    });

    it('should reject non-integer values', () => {
      expect(() => Money.fromKobo(100.5)).toThrow('integer');
    });

    it('should reject negative values', () => {
      expect(() => Money.fromKobo(-1)).toThrow('between');
    });

    it('should reject values exceeding max', () => {
      expect(() => Money.fromKobo(922_337_203_685_478)).toThrow('between');
    });
  });

  describe('fromNaira', () => {
    it('should create Money from Naira', () => {
      const money = Money.fromNaira(100.5);
      expect(money.toKobo()).toBe(10050);
      expect(money.toNaira()).toBe(100.5);
    });

    it('should round to nearest kobo', () => {
      const money = Money.fromNaira(100.505);
      expect(money.toKobo()).toBe(10051);
    });
  });

  describe('arithmetic operations', () => {
    it('should add two Money values', () => {
      const a = Money.fromKobo(1000);
      const b = Money.fromKobo(500);
      const result = a.add(b);
      expect(result.toKobo()).toBe(1500);
    });

    it('should subtract two Money values', () => {
      const a = Money.fromKobo(1000);
      const b = Money.fromKobo(300);
      const result = a.subtract(b);
      expect(result.toKobo()).toBe(700);
    });

    it('should multiply Money by factor', () => {
      const money = Money.fromKobo(1000);
      const result = money.multiply(2.5);
      expect(result.toKobo()).toBe(2500);
    });

    it('should divide Money by divisor', () => {
      const money = Money.fromKobo(1000);
      const result = money.divide(4);
      expect(result.toKobo()).toBe(250);
    });

    it('should throw on division by zero', () => {
      const money = Money.fromKobo(1000);
      expect(() => money.divide(0)).toThrow('divide by zero');
    });

    it('should round multiplication results', () => {
      const money = Money.fromKobo(100);
      const result = money.multiply(1.555);
      expect(result.toKobo()).toBe(156);
    });
  });

  describe('comparison operations', () => {
    it('should check equality', () => {
      const a = Money.fromKobo(1000);
      const b = Money.fromKobo(1000);
      const c = Money.fromKobo(500);
      expect(a.equals(b)).toBe(true);
      expect(a.equals(c)).toBe(false);
    });

    it('should compare greater than', () => {
      const a = Money.fromKobo(1000);
      const b = Money.fromKobo(500);
      expect(a.greaterThan(b)).toBe(true);
      expect(b.greaterThan(a)).toBe(false);
    });

    it('should compare less than', () => {
      const a = Money.fromKobo(500);
      const b = Money.fromKobo(1000);
      expect(a.lessThan(b)).toBe(true);
      expect(b.lessThan(a)).toBe(false);
    });
  });

  describe('toString', () => {
    it('should format as Naira string', () => {
      const money = Money.fromKobo(10050);
      expect(money.toString()).toBe('₦100.50');
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { ClockService } from './time.service.js';

describe('ClockService', () => {
  let service: ClockService;

  beforeEach(() => {
    service = new ClockService();
  });

  describe('now', () => {
    it('should return current date', () => {
      const before = Date.now();
      const now = service.now();
      const after = Date.now();

      expect(now.getTime()).toBeGreaterThanOrEqual(before);
      expect(now.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('Lagos timezone operations', () => {
    it('should get start of day in Lagos timezone', () => {
      const date = new Date('2024-01-15T14:30:00.000Z');
      const start = service.startOfDayLagos(date);
      const formatted = service.formatLagos(start, 'HH:mm:ss');

      expect(formatted).toBe('00:00:00');
    });

    it('should get end of day in Lagos timezone', () => {
      const date = new Date('2024-01-15T14:30:00.000Z');
      const end = service.endOfDayLagos(date);
      const formatted = service.formatLagos(end, 'HH:mm:ss.SSS');

      expect(formatted).toBe('23:59:59.999');
    });

    it('should format date to Lagos timezone', () => {
      const date = new Date('2024-01-15T12:00:00.000Z');
      const formatted = service.formatLagos(date, 'yyyy-MM-dd HH:mm:ss');

      // Lagos is UTC+1, so 12:00 UTC becomes 13:00 Lagos
      expect(formatted).toBe('2024-01-15 13:00:00');
    });

    it('should get Lagos day string', () => {
      const date = new Date('2024-01-15T23:30:00.000Z');
      const day = service.lagosDay(date);

      // 23:30 UTC is 00:30 next day in Lagos
      expect(day).toBe('2024-01-16');
    });
  });

  describe('todayLagos', () => {
    it('should return start of current day in Lagos', () => {
      const today = service.todayLagos();
      const formatted = service.formatLagos(today, 'HH:mm:ss');

      expect(formatted).toBe('00:00:00');
    });
  });
});

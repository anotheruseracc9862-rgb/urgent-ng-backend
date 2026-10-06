import { Injectable } from '@nestjs/common';
import { formatInTimeZone } from 'date-fns-tz';
import { startOfDay, endOfDay } from 'date-fns';

const LAGOS_TIMEZONE = 'Africa/Lagos';

/**
 * Injectable Clock service for time operations
 * Allows tests to control time by mocking this service
 */
@Injectable()
export class ClockService {
  /**
   * Get current time as Date
   */
  now(): Date {
    return new Date();
  }

  /**
   * Get current date in Lagos timezone (start of day)
   */
  todayLagos(): Date {
    const now = this.now();
    return this.startOfDayLagos(now);
  }

  /**
   * Get start of day in Lagos timezone
   */
  startOfDayLagos(date: Date): Date {
    const lagosDateStr = formatInTimeZone(date, LAGOS_TIMEZONE, 'yyyy-MM-dd');
    return new Date(`${lagosDateStr}T00:00:00.000+01:00`);
  }

  /**
   * Get end of day in Lagos timezone
   */
  endOfDayLagos(date: Date): Date {
    const lagosDateStr = formatInTimeZone(date, LAGOS_TIMEZONE, 'yyyy-MM-dd');
    return new Date(`${lagosDateStr}T23:59:59.999+01:00`);
  }

  /**
   * Format date to Lagos timezone string
   */
  formatLagos(date: Date, format: string = 'yyyy-MM-dd HH:mm:ss'): string {
    return formatInTimeZone(date, LAGOS_TIMEZONE, format);
  }

  /**
   * Get Lagos day string (YYYY-MM-DD) for a given date
   */
  lagosDay(date: Date): string {
    return formatInTimeZone(date, LAGOS_TIMEZONE, 'yyyy-MM-dd');
  }
}

import { describe, expect, it } from 'vitest';
import { assertNoContactDetails, findContactDetails } from './contact-details.js';

describe('findContactDetails', () => {
  it.each([
    'call me 08147877487',
    'Can you do it? call my number 0814 787 7487',
    'whatsapp +234 814 787 7487',
    'text 234-814-787-7487',
    'my line is 814.787.7487',
    '0 8 1 4 7 8 7 7 4 8 7',
    '+1 (415) 555-2671',
  ])('finds a phone number in %j', (text) => {
    expect(findContactDetails(text)).toBe('PHONE');
  });

  it.each(['mail me at ade@example.com', 'ade (at) example (dot) com', 'ade @ example . com'])('finds an email in %j', (text) => {
    expect(findContactDetails(text)).toBe('EMAIL');
  });

  it.each([
    'it will actually take 3 hours and cost 5k',
    'I can do it for ₦5,000 in 2 hrs',
    'Posted 19 Oct 2026, 20:36',
    '19.10.2026 20.36',
    'flat 12, 34 Allen Avenue',
    'budget 1,500,000 naira',
    '',
  ])('leaves %j alone', (text) => {
    expect(findContactDetails(text)).toBeNull();
  });

  it('handles empty input', () => {
    expect(findContactDetails(null)).toBeNull();
    expect(findContactDetails(undefined)).toBeNull();
  });
});

describe('assertNoContactDetails', () => {
  it('throws a validation error that names the field', () => {
    expect(() => assertNoContactDetails('call 08147877487', 'message')).toThrowError(/phone number/);
  });

  it('passes clean text', () => {
    expect(() => assertNoContactDetails('Happy to help today.', 'message')).not.toThrow();
  });
});

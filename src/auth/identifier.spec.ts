import { describe, expect, it } from 'vitest';
import { maskIdentifier, normaliseEmail, singleIdentifier } from './identifier.js';

describe('identifier helpers', () => {
  it('lower-cases and trims emails', () => {
    expect(normaliseEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it('accepts exactly one of phone or email', () => {
    expect(singleIdentifier({ phone: '+2348031234567' })).toEqual({ kind: 'phone', value: '+2348031234567' });
    expect(singleIdentifier({ email: 'a@b.co' })).toEqual({ kind: 'email', value: 'a@b.co' });
  });

  it('rejects none or both', () => {
    expect(() => singleIdentifier({})).toThrow();
    expect(() => singleIdentifier({ phone: '+2348031234567', email: 'a@b.co' })).toThrow();
    expect(() => singleIdentifier({ phone: '', email: '' })).toThrow();
  });

  it('masks all but the first and last two characters', () => {
    expect(maskIdentifier('+2348031234567')).toBe('+2****67');
    expect(maskIdentifier('abc')).toBe('****');
  });
});

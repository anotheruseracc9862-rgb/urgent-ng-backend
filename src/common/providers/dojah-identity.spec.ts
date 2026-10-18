import { describe, it, expect } from 'vitest';
import { parseRegistryDate, readRegistryIdentity } from './dojah-identity.js';

describe('parseRegistryDate', () => {
  it.each([
    ['15-Apr-1985', '1985-04-15'],
    ['10-06-1983', '1983-06-10'],
    ['1983-06-10', '1983-06-10'],
    ['10/06/1983', '1983-06-10'],
    ['5 Jun 1990', '1990-06-05'],
  ])('%s -> %s', (input, expected) => {
    expect(parseRegistryDate(input)).toBe(expected);
  });

  it.each(['', 'nope', '31-02-1990', '32-Jan-1990', undefined, 42])('%s -> undefined', (input) => {
    expect(parseRegistryDate(input)).toBeUndefined();
  });
});

describe('readRegistryIdentity', () => {
  it('reads the first_name shape', () => {
    expect(readRegistryIdentity({ first_name: 'JOHN', middle_name: 'DOE', last_name: 'MUSA', date_of_birth: '15-Apr-1985' })).toEqual({
      firstName: 'JOHN',
      middleName: 'DOE',
      lastName: 'MUSA',
      dateOfBirth: '1985-04-15',
    });
  });
  it('reads the firstname/surname/birthdate shape', () => {
    expect(readRegistryIdentity({ firstname: 'ADA', surname: 'OKAFOR', birthdate: '10-06-1983' })).toEqual({
      firstName: 'ADA',
      lastName: 'OKAFOR',
      dateOfBirth: '1983-06-10',
    });
  });
  it('returns undefined when a name or the date is missing', () => {
    expect(readRegistryIdentity({ first_name: 'ADA', date_of_birth: '15-Apr-1985' })).toBeUndefined();
    expect(readRegistryIdentity({ first_name: 'ADA', last_name: 'OKAFOR' })).toBeUndefined();
    expect(readRegistryIdentity({ first_name: 'ADA', last_name: 'OKAFOR', date_of_birth: 'soon' })).toBeUndefined();
    expect(readRegistryIdentity(undefined)).toBeUndefined();
  });
});

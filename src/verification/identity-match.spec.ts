import { describe, it, expect } from 'vitest';
import { identityMatches, namesMatch, nameTokens, personKey, sameFullName } from './identity-match.js';

const registry = { firstName: 'ADA', middleName: 'CHINWE', lastName: 'OKAFOR', dateOfBirth: '1994-03-21' };

describe('nameTokens', () => {
  it('lowers case, strips accents and punctuation', () => {
    expect(nameTokens("O'Brien-Adé", ' Chi  ')).toEqual(['obrien', 'ade', 'chi']);
  });
});

describe('namesMatch', () => {
  it('matches the same names in any case', () => {
    expect(namesMatch({ firstName: 'ada', lastName: 'Okafor' }, registry)).toBe(true);
  });
  it('matches swapped order', () => {
    expect(namesMatch({ firstName: 'Okafor', lastName: 'Ada' }, registry)).toBe(true);
  });
  it('matches when the runner also types the middle name', () => {
    expect(namesMatch({ firstName: 'Ada Chinwe', lastName: 'Okafor' }, registry)).toBe(true);
  });
  it('allows one typo in a long word only', () => {
    expect(namesMatch({ firstName: 'Ada', lastName: 'Okafar' }, registry)).toBe(true);
    expect(namesMatch({ firstName: 'Ade', lastName: 'Okafor' }, registry)).toBe(false);
  });
  it('refuses a different person', () => {
    expect(namesMatch({ firstName: 'Musa', lastName: 'Ibrahim' }, registry)).toBe(false);
  });
  it('refuses one name typed twice', () => {
    expect(namesMatch({ firstName: 'Ada', lastName: 'Ada' }, registry)).toBe(false);
  });
  it('refuses a name with no letters', () => {
    expect(namesMatch({ firstName: '---', lastName: '123' }, registry)).toBe(false);
  });
});

describe('identityMatches', () => {
  it('needs the exact date of birth', () => {
    expect(identityMatches({ firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1994-03-21' }, registry)).toBe(true);
    expect(identityMatches({ firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1994-03-22' }, registry)).toBe(false);
  });
});

describe('personKey', () => {
  it('is the same for swapped names and ignores the middle name', () => {
    expect(personKey(registry)).toBe(personKey({ firstName: 'Okafor', lastName: 'Ada', dateOfBirth: '1994-03-21' }));
  });
  it('differs by date of birth', () => {
    expect(personKey(registry)).not.toBe(personKey({ ...registry, dateOfBirth: '1994-03-22' }));
  });
});

describe('sameFullName', () => {
  it('matches the same name in any order, case or with a middle name', () => {
    expect(sameFullName('Ada Okafor', 'okafor ada')).toBe(true);
    expect(sameFullName('Ada Okafor', 'Ada Chinwe Okafor')).toBe(true);
  });
  it('does not match different people or a single shared word', () => {
    expect(sameFullName('Ngozi Okafor', 'Ada Okafor')).toBe(false);
    expect(sameFullName('Ada', 'Ada Okafor')).toBe(false);
  });
});

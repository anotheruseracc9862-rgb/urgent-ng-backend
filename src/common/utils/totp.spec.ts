import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpCode,
  totpStep,
  totpUri,
  verifyTotp,
} from './totp.js';

// RFC 6238 appendix B test vectors (SHA1, secret "12345678901234567890").
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('matches the RFC 6238 test vectors (last 6 digits)', () => {
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ];

    for (const [seconds, expected] of vectors) {
      expect(totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(expected);
    }
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from('hello world, this is a secret');

    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it('rejects an invalid base32 character', () => {
    expect(() => base32Decode('abc1')).toThrow('Invalid base32');
  });

  it('generates different 32-character secrets', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();

    expect(a).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it('verifies the current code and returns its step', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;

    expect(verifyTotp(secret, totpCode(secret, totpStep(now)), now)).toBe(totpStep(now));
  });

  it('accepts one step of clock drift but not two', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const step = totpStep(now);

    expect(verifyTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), now)).toBeNull();
  });

  it('rejects wrong or malformed codes', () => {
    const secret = generateTotpSecret();

    expect(verifyTotp(secret, '000000', 1_700_000_000_000)).toBeNull();
    expect(verifyTotp(secret, 'abcdef')).toBeNull();
    expect(verifyTotp(secret, '12345')).toBeNull();
  });

  it('builds an otpauth URI', () => {
    expect(totpUri('ABC', 'admin@urgent.ng')).toMatch(
      /^otpauth:\/\/totp\/Urgent\.ng%3Aadmin%40urgent\.ng\?secret=ABC&issuer=Urgent\.ng/,
    );
  });
});

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) with HMAC-SHA1, 6 digits and a 30 second step: the profile
 * every authenticator app supports. No external dependency.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32 character');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The time step (counter) a moment in time falls in. */
export function totpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/**
 * Check a code against the current step and one step either side (clock drift).
 * Returns the matching step, or null. The caller must remember the step and
 * refuse to accept it twice (replay protection).
 */
export function verifyTotp(
  secret: string,
  code: string,
  atMs: number = Date.now(),
  window = 1,
): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  const current = totpStep(atMs);
  const given = Buffer.from(code);
  for (let drift = -window; drift <= window; drift++) {
    const expected = Buffer.from(totpCode(secret, current + drift));
    if (timingSafeEqual(expected, given)) {
      return current + drift;
    }
  }
  return null;
}

/** otpauth:// URI for QR codes. */
export function totpUri(secret: string, accountName: string, issuer = 'Urgent.ng'): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return (
    `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_SECONDS}`
  );
}

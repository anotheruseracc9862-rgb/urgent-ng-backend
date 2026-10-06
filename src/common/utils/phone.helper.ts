/**
 * Nigerian mobile number helpers (E.164 +234...).
 *
 * Accepted inputs (spaces, hyphens, dots and brackets are ignored):
 * - 0803 123 4567      national format, 11 digits starting with 0
 * - 2348031234567      country code without +
 * - +2348031234567     E.164
 * - +23408031234567    country code followed by the national leading 0
 *                      (a very common way people type their number)
 *
 * Mobile prefixes accepted: 070x, 080x, 081x, 090x, 091x.
 */

const VALID_PREFIXES = ['70', '80', '81', '90', '91'];

/**
 * Normalise to +234XXXXXXXXXX, or return null when the input is not a valid
 * Nigerian mobile number.
 */
function tryNormalize(phone: string): string | null {
  const cleaned = phone.replace(/[\s\-.()]/g, '');

  let national: string | undefined; // the 10 digits after the country code
  let match: RegExpExecArray | null;

  if ((match = /^0(\d{10})$/.exec(cleaned))) {
    national = match[1];
  } else if ((match = /^\+?234(\d{10})$/.exec(cleaned))) {
    national = match[1];
  } else if ((match = /^\+?2340(\d{10})$/.exec(cleaned))) {
    national = match[1];
  }

  if (!national || !VALID_PREFIXES.includes(national.slice(0, 2))) {
    return null;
  }
  return '+234' + national;
}

/**
 * Normalize a Nigerian phone number to E.164 (+234XXXXXXXXXX).
 * Throws when the number is not a valid Nigerian mobile number.
 */
export function normalizePhone(phone: string): string {
  if (!phone) {
    throw new Error('Phone number is required');
  }

  const normalized = tryNormalize(phone);
  if (!normalized) {
    throw new Error(
      'Invalid Nigerian phone number. Use 080..., 234..., or +234... and a prefix of 070, 080, 081, 090 or 091',
    );
  }
  return normalized;
}

/**
 * Validate if phone number is a valid Nigerian mobile number
 */
export function isValidNigerianPhone(phone: string): boolean {
  return typeof phone === 'string' && tryNormalize(phone) !== null;
}

/**
 * Check if a phone number has a valid Nigerian mobile prefix.
 * Kept for backwards compatibility; equivalent to `isValidNigerianPhone`.
 */
export function hasValidNigerianPrefix(phone: string): boolean {
  return isValidNigerianPhone(phone);
}

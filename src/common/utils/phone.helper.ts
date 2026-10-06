/**
 * Normalize Nigerian phone number to E.164 format (+234...)
 * 
 * Accepts:
 * - 070x..., 080x..., 081x..., 090x..., 091x... (11 digits starting with 0)
 * - 234... (13 digits without +)
 * - +234... (14 characters with +)
 * 
 * Returns: +234XXXXXXXXXX (E.164 format)
 */
export function normalizePhone(phone: string): string {
  if (!phone) {
    throw new Error('Phone number is required');
  }

  // Remove all whitespace and non-digit characters except +
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');

  let normalized: string;

  // Pattern 1: 080... (starts with 0, 11 digits)
  if (/^0\d{10}$/.test(cleaned)) {
    normalized = '+234' + cleaned.slice(1);
  }
  // Pattern 2: 234... (starts with 234, 13 digits)
  else if (/^234\d{10}$/.test(cleaned)) {
    normalized = '+' + cleaned;
  }
  // Pattern 3: +234... (starts with +234, 14 characters)
  else if (/^\+234\d{10}$/.test(cleaned)) {
    normalized = cleaned;
  }
  else {
    throw new Error(
      'Invalid Nigerian phone number. Expected formats: 080..., 234..., or +234...',
    );
  }

  // Validate prefix
  if (!hasValidNigerianPrefix(normalized)) {
    throw new Error(
      'Invalid Nigerian phone number. Must start with 070x, 080x, 081x, 090x, or 091x',
    );
  }

  return normalized;
}

/**
 * Validate if phone number is a valid Nigerian number
 */
export function isValidNigerianPhone(phone: string): boolean {
  try {
    normalizePhone(phone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if phone number starts with valid Nigerian prefix
 * Valid prefixes: 070, 080, 081, 090, 091
 * 
 * Note: This is a helper for internal validation.
 * For complete validation, use normalizePhone which calls this.
 */
export function hasValidNigerianPrefix(phone: string): boolean {
  try {
    // Handle already normalized format
    let normalized = phone;
    if (!phone.startsWith('+234')) {
      // Clean and normalize without recursion
      const cleaned = phone.replace(/[\s\-\(\)]/g, '');
      if (/^0\d{10}$/.test(cleaned)) {
        normalized = '+234' + cleaned.slice(1);
      } else if (/^234\d{10}$/.test(cleaned)) {
        normalized = '+' + cleaned;
      } else if (/^\+234\d{10}$/.test(cleaned)) {
        normalized = cleaned;
      } else {
        return false;
      }
    }

    // Check the first 2 digits after +234 (the prefix without leading 0)
    // "+2348012345678" -> check "80" (which represents 080 in local format)
    const firstTwoDigits = normalized.slice(4, 6);
    const validPrefixes = ['70', '80', '81', '90', '91'];
    return validPrefixes.includes(firstTwoDigits);
  } catch {
    return false;
  }
}

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const FORMAT_VERSION = 'v1';
const DEFAULT_KEY_ID = 'primary';
const keyCache = new Map<string, Buffer>();

/**
 * Generate HMAC-SHA256 signature (hex)
 */
export function hmacSign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Verify an HMAC-SHA256 signature in constant time
 */
export function hmacVerify(
  data: string,
  signature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(hmacSign(data, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Derive a 32-byte AES key from a secret of any length with HKDF-SHA256.
 * Never pad or truncate the secret: that wastes entropy and breaks on
 * multibyte characters.
 */
function deriveKey(secret: string): Buffer {
  let key = keyCache.get(secret);
  if (!key) {
    key = Buffer.from(
      hkdfSync('sha256', secret, 'urgent-ng-salt-v1', 'aes-256-gcm', 32),
    );
    keyCache.set(secret, key);
  }
  return key;
}

/**
 * Encrypt plaintext with AES-256-GCM.
 *
 * Output format: `v1.<keyId>.<iv>.<authTag>.<ciphertext>` (base64 parts).
 * The key ID is stored with the value (and in the `encryptionKeyId` column) so
 * keys can be rotated: decrypt with the key that matches `readKeyId()`.
 * `aad` binds the ciphertext to its context (for example the row ID) and must
 * be supplied again to decrypt.
 */
export function encrypt(
  plaintext: string,
  secret: string,
  options: { keyId?: string; aad?: string } = {},
): string {
  const keyId = options.keyId ?? DEFAULT_KEY_ID;
  if (!/^[A-Za-z0-9_-]+$/.test(keyId)) {
    throw new Error('Invalid key ID');
  }

  const iv = randomBytes(12); // 12 bytes recommended for GCM
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  if (options.aad) {
    cipher.setAAD(Buffer.from(options.aad));
  }

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return [
    FORMAT_VERSION,
    keyId,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

/**
 * Read the key ID stored in an encrypted value without decrypting it.
 */
export function readKeyId(ciphertext: string): string {
  const parts = ciphertext.split('.');
  if (parts.length !== 5 || parts[0] !== FORMAT_VERSION) {
    throw new Error('Invalid ciphertext format');
  }
  return parts[1];
}

/**
 * Decrypt a value produced by `encrypt`. Any failure (wrong key, tampering,
 * wrong AAD, bad format) throws a generic error.
 */
export function decrypt(
  ciphertext: string,
  secret: string,
  options: { aad?: string } = {},
): string {
  try {
    const parts = ciphertext.split('.');
    if (parts.length !== 5 || parts[0] !== FORMAT_VERSION) {
      throw new Error('Invalid ciphertext format');
    }

    const [, , ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(secret),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    if (options.aad) {
      decipher.setAAD(Buffer.from(options.aad));
    }

    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Decryption failed');
  }
}

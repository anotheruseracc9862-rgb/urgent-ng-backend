import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Generate HMAC-SHA256 signature
 */
export function hmacSign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Verify HMAC-SHA256 signature
 */
export function hmacVerify(
  data: string,
  signature: string,
  secret: string,
): boolean {
  const expected = hmacSign(data, secret);
  return signature === expected;
}

/**
 * Encrypt plaintext using AES-256-GCM
 * Returns base64-encoded string: iv:authTag:ciphertext
 */
export function encrypt(plaintext: string, key: string): string {
  // Ensure key is 32 bytes for AES-256
  const keyBuffer = Buffer.from(key.padEnd(32, '0').slice(0, 32));
  
  // Generate random IV (12 bytes recommended for GCM)
  const iv = randomBytes(12);
  
  const cipher = createCipheriv('aes-256-gcm', keyBuffer, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  
  const authTag = cipher.getAuthTag();
  
  // Combine iv:authTag:ciphertext
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted,
  ].join(':');
}

/**
 * Decrypt AES-256-GCM encrypted string
 */
export function decrypt(ciphertext: string, key: string): string {
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid ciphertext format');
    }
    
    const [ivB64, authTagB64, encryptedB64] = parts;
    
    // Ensure key is 32 bytes for AES-256
    const keyBuffer = Buffer.from(key.padEnd(32, '0').slice(0, 32));
    
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    
    const decipher = createDecipheriv('aes-256-gcm', keyBuffer, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedB64, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    throw new Error('Decryption failed');
  }
}

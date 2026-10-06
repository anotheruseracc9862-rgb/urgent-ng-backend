import { describe, it, expect } from 'vitest';
import { hmacSign, hmacVerify, encrypt, decrypt } from './crypto.helper.js';

describe('Crypto Helpers', () => {
  describe('HMAC operations', () => {
    const secret = 'test-secret-key';

    it('should generate HMAC signature', () => {
      const data = 'test data';
      const signature = hmacSign(data, secret);

      expect(signature).toBeDefined();
      expect(typeof signature).toBe('string');
      expect(signature.length).toBe(64); // SHA256 hex is 64 chars
    });

    it('should verify valid HMAC signature', () => {
      const data = 'test data';
      const signature = hmacSign(data, secret);

      expect(hmacVerify(data, signature, secret)).toBe(true);
    });

    it('should reject invalid HMAC signature', () => {
      const data = 'test data';
      const signature = hmacSign(data, secret);
      const tamperedSignature = signature.slice(0, -1) + 'x';

      expect(hmacVerify(data, tamperedSignature, secret)).toBe(false);
    });

    it('should reject signature for different data', () => {
      const data1 = 'test data 1';
      const data2 = 'test data 2';
      const signature = hmacSign(data1, secret);

      expect(hmacVerify(data2, signature, secret)).toBe(false);
    });

    it('should generate different signatures for different secrets', () => {
      const data = 'test data';
      const sig1 = hmacSign(data, 'secret1');
      const sig2 = hmacSign(data, 'secret2');

      expect(sig1).not.toBe(sig2);
    });
  });

  describe('AES-GCM encryption', () => {
    const key = 'my-32-byte-encryption-key-123';

    it('should encrypt and decrypt plaintext', () => {
      const plaintext = 'sensitive data';
      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext each time', () => {
      const plaintext = 'sensitive data';
      const encrypted1 = encrypt(plaintext, key);
      const encrypted2 = encrypt(plaintext, key);

      // Different IVs should produce different ciphertext
      expect(encrypted1).not.toBe(encrypted2);
      
      // But both should decrypt to same plaintext
      expect(decrypt(encrypted1, key)).toBe(plaintext);
      expect(decrypt(encrypted2, key)).toBe(plaintext);
    });

    it('should handle empty string', () => {
      const plaintext = '';
      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle long text', () => {
      const plaintext = 'a'.repeat(10000);
      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle special characters', () => {
      const plaintext = '🚀 Special: @#$%^&*()_+-=[]{}|;:",.<>?/';
      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    it('should fail with wrong key', () => {
      const plaintext = 'sensitive data';
      const encrypted = encrypt(plaintext, key);

      expect(() => decrypt(encrypted, 'wrong-key')).toThrow('Decryption failed');
    });

    it('should fail with tampered ciphertext', () => {
      const plaintext = 'sensitive data';
      const encrypted = encrypt(plaintext, key);
      const tampered = encrypted.slice(0, -5) + 'xxxxx';

      expect(() => decrypt(tampered, key)).toThrow('Decryption failed');
    });

    it('should fail with invalid format', () => {
      expect(() => decrypt('invalid-format', key)).toThrow('Decryption failed');
    });
  });
});

import { randomBytes, randomUUID } from 'node:crypto';

// Monotonic counter for UUIDv7 within same millisecond
let lastTimestamp = 0;
let counter = 0;

/**
 * Generate UUIDv7 (time-ordered UUID)
 * 
 * UUIDv7 format: xxxxxxxx-xxxx-7xxx-xxxx-xxxxxxxxxxxx
 * where the first 48 bits are Unix timestamp in milliseconds
 * and a monotonic counter ensures ordering within the same millisecond
 */
export function generateUuidV7(): string {
  let now = Date.now();
  
  // Handle monotonic ordering within same millisecond
  if (now === lastTimestamp) {
    counter++;
  } else {
    lastTimestamp = now;
    counter = 0;
  }
  
  // Combine timestamp and counter for 48 bits
  const timestampWithCounter = now * 4096 + (counter % 4096);
  const timestampHex = timestampWithCounter.toString(16).padStart(12, '0');
  
  // Generate random bytes for the rest
  const random = randomBytes(10);
  
  // Combine timestamp with random parts
  // Format: tttttttt-tttt-7xxx-xxxx-xxxxxxxxxxxx
  return [
    timestampHex.slice(0, 8),
    timestampHex.slice(8, 12),
    '7' + random.subarray(0, 2).toString('hex').slice(1),
    random.subarray(2, 4).toString('hex'),
    random.subarray(4, 10).toString('hex'),
  ].join('-');
}

/**
 * Generate standard UUIDv4
 */
export function generateUuid(): string {
  return randomUUID();
}

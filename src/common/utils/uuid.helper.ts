import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';

/**
 * Generate a UUIDv7 (RFC 9562): a 48-bit millisecond timestamp, version and
 * variant bits, and a monotonic counter so IDs created in the same
 * millisecond still sort in creation order.
 */
export function generateUuidV7(): string {
  return v7();
}

/**
 * Read the millisecond timestamp encoded in a UUIDv7.
 */
export function uuidV7Timestamp(uuid: string): number {
  return Number.parseInt(uuid.replace(/-/g, '').slice(0, 12), 16);
}

/**
 * Generate standard UUIDv4
 */
export function generateUuid(): string {
  return randomUUID();
}

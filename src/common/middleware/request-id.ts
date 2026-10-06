import { randomUUID } from 'node:crypto';

/** Client supplied IDs are only trusted if they are short and log-safe. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Return the client's `x-request-id` when it is safe, otherwise a new UUID.
 * Used by both the pino request logger and the request-id middleware so the
 * log line and the response always carry the same ID.
 */
export function resolveRequestId(header: unknown): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return typeof candidate === 'string' && SAFE_REQUEST_ID.test(candidate)
    ? candidate
    : randomUUID();
}

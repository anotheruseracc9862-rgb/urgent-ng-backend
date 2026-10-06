import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent';

export interface IdempotentOptions {
  /**
   * Operation name for idempotency tracking.
   * Used to namespace idempotency keys per operation type.
   */
  operation: string;

  /**
   * TTL in seconds for idempotency records.
   * After this time, the idempotency key can be reused.
   * Defaults to 24 hours (86400 seconds).
   */
  ttlSeconds?: number;

  /**
   * Whether to extract userId from request user object.
   * If false, operation is not user-scoped.
   * Defaults to true.
   */
  requireUser?: boolean;
}

/**
 * Decorator to mark a controller method as idempotent.
 * Requires an 'Idempotency-Key' header in the request.
 *
 * Usage:
 * ```typescript
 * @Post('create')
 * @Idempotent({ operation: 'create-errand' })
 * async createErrand(@Body() dto: CreateErrandDto) {
 *   // ...
 * }
 * ```
 *
 * The decorator metadata is read by IdempotencyInterceptor.
 */
export const Idempotent = (options: IdempotentOptions) =>
  SetMetadata(IDEMPOTENT_KEY, options);

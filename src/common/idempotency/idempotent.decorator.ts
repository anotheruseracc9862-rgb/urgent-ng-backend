import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { ApiHeader, ApiResponse } from '@nestjs/swagger';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

export const IDEMPOTENT_KEY = 'idempotent';

export interface IdempotentOptions {
  /**
   * Operation name for idempotency tracking.
   * Used to namespace idempotency keys per operation type.
   */
  operation: string;
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
 * The decorator also applies IdempotencyInterceptor, so a route is protected
 * by this one decorator. The module that owns the controller must import
 * IdempotencyModule.
 */
export const Idempotent = (options: IdempotentOptions) =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_KEY, options),
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description: '8 to 128 characters (letters, digits, . _ : -). Same key and body replays the first response.',
    }),
    ApiResponse({ status: 409, description: 'Key reused with a different body, or the first request is still running.' }),
  );

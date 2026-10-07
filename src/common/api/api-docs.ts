import { applyDecorators, HttpStatus, Type } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

/** Error body every non-2xx answer uses (Backend PRD 31). */
export class ErrorDetailDto {
  @ApiProperty({ example: 'INVALID_CREDENTIALS' })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  details?: Record<string, unknown>;
}

export class ErrorBodyDto {
  @ApiProperty({ type: ErrorDetailDto })
  error!: ErrorDetailDto;

  @ApiProperty()
  requestId!: string;
}

interface EnvelopeOptions {
  status?: number;
  isArray?: boolean;
  description?: string;
}

/**
 * Document a success response in the standard envelope `{ data, meta, requestId }`.
 * Pass the response class for `data`, or null for an empty body (204).
 */
export function ApiEnveloped(model: Type<unknown> | null, options: EnvelopeOptions = {}) {
  const status = options.status ?? HttpStatus.OK;
  if (model === null) {
    return ApiResponse({ status, description: options.description ?? 'No content' });
  }
  const data = options.isArray
    ? { type: 'array', items: { $ref: getSchemaPath(model) } }
    : { $ref: getSchemaPath(model) };

  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status,
      description: options.description ?? 'Success',
      schema: {
        type: 'object',
        required: ['data', 'requestId'],
        properties: {
          data,
          meta: { type: 'object', additionalProperties: true },
          requestId: { type: 'string' },
        },
      },
    }),
  );
}

/** Document the error statuses a route can return, all with the standard error body. */
export function ApiErrors(...statuses: number[]) {
  return applyDecorators(
    ApiExtraModels(ErrorBodyDto),
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: 'Error (see `error.code`)',
        schema: { $ref: getSchemaPath(ErrorBodyDto) },
      }),
    ),
  );
}

/** Consumer routes accept the bearer token or the `ung_at` cookie. */
export const ApiConsumerAuth = () =>
  applyDecorators(ApiBearerAuth('consumer'), ApiCookieAuth('consumer-cookie'), ApiErrors(401, 403));

/** Admin routes accept the admin bearer token or the `ung_admin_at` cookie. */
export const ApiAdminAuth = () =>
  applyDecorators(ApiBearerAuth('admin'), ApiCookieAuth('admin-cookie'), ApiErrors(401, 403));

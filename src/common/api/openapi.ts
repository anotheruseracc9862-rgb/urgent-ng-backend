import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * The one place the API document is built, so the Swagger UI (main.ts) and the
 * exported file (`npm run openapi`) can never differ.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Urgent.ng API')
    .setDescription(
      [
        'Urgent.ng errand marketplace backend. All paths are under `/api/v1`.',
        '',
        '**Envelope.** Every success answer is `{ data, meta, requestId }`. Every error is `{ error: { code, message, details? }, requestId }`; branch on `error.code`, never on the message.',
        '',
        '**Authentication.** Web clients use HTTP-only cookies (`ung_at` access, `ung_rt` refresh). Mobile clients send `X-Client: mobile` on login and refresh, receive the tokens in the body and send `Authorization: Bearer <accessToken>`. Admin routes use a separate token and the `ung_admin_at` cookie; a consumer token never works there.',
        '',
        '**Idempotency.** Routes marked as idempotent need an `Idempotency-Key` header (8 to 128 characters). Repeating the same key and body replays the first response.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'consumer')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'admin')
    .addCookieAuth('ung_at', { type: 'apiKey', in: 'cookie', name: 'ung_at' }, 'consumer-cookie')
    .addCookieAuth('ung_admin_at', { type: 'apiKey', in: 'cookie', name: 'ung_admin_at' }, 'admin-cookie')
    .addServer('/')
    .build();

  return SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controllerKey: string, methodKey: string) =>
      `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
  });
}

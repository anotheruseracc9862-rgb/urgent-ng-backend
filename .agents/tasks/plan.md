# Implementation Plan: P0-04 — Response Envelope and Request IDs

**Task:** P0-04 from Backend Build Plan — Response envelope and request IDs  
**Complexity:** Small  
**Context:** NestJS + Pino logger (via nestjs-pino). P0-03 is complete: `DomainExceptionFilter` is wired as APP_FILTER in `AppModule` and already reads `x-request-id` from request headers (falling back to `'unknown'`) to include in error responses.

## Exploration Findings

- **AppModule** (`src/app.module.ts`): Already has `APP_FILTER` provider for `DomainExceptionFilter` and `APP_GUARD` for `ThrottlerGuard`. LoggerModule from nestjs-pino is configured globally.
- **DomainExceptionFilter** (`src/common/filters/domain-exception.filter.ts`): Reads `x-request-id` header; if missing, uses `'unknown'`. Returns error envelope `{ error: { code, message, details? }, requestId }`.
- **Directory structure**: `src/common/` has subdirectories for `decorators/`, `interceptors/`, `middleware/` (doesn't exist yet), `filters/`, `guards/`, etc. The `decorators/` and `interceptors/` folders currently contain only `.gitkeep`.
- **UUID generation**: Node.js crypto.randomUUID is available (confirmed via test).
- **Test framework**: vitest with globals enabled. Existing test (`domain-exception.filter.spec.ts`) demonstrates the pattern: mock request/response, use vi.fn(), describe/it/expect/beforeEach.
- **Test command**: `npm test` runs unit tests (`src/**/*.spec.ts`).
- **Build command**: `npm run build` compiles TypeScript.
- **Check command**: `npm run check` runs lint, build, and unit tests.

## Implementation Plan

- [ ] 1. **Create the request ID middleware** in `src/common/middleware/request-id.middleware.ts`.
      - Implement NestJS `NestMiddleware` that reads the incoming `x-request-id` header; if absent, generates a UUIDv4 using Node.js `crypto.randomUUID()`.
      - Set the `x-request-id` header on both the request (for downstream use) and the response (for client visibility).
      - Bind the requestId to the Pino logger context by injecting `PinoLogger` from nestjs-pino and calling `logger.assign({ requestId })` so every log line in that request carries the ID.
      Files: `src/common/middleware/request-id.middleware.ts`
      Verify: Unit tests pass (`npm test` for `src/common/middleware/request-id.middleware.spec.ts`).

- [ ] 2. **Wire the middleware globally in AppModule**.
      - Import `MiddlewareConsumer` and `NestModule` from `@nestjs/common`.
      - Make `AppModule` implement `NestModule` with a `configure(consumer: MiddlewareConsumer)` method.
      - Apply `RequestIdMiddleware` to all routes using `consumer.apply(RequestIdMiddleware).forRoutes('*')`.
      Files: `src/app.module.ts`
      Verify: `npm run build` succeeds without errors.

- [ ] 3. **Create the @NoEnvelope decorator** in `src/common/decorators/no-envelope.decorator.ts`.
      - Simple metadata decorator using `SetMetadata('NO_ENVELOPE', true)` to mark SSE endpoints and webhooks that should skip envelope wrapping.
      Files: `src/common/decorators/no-envelope.decorator.ts`
      Verify: Unit tests pass (`npm test` for `src/common/decorators/no-envelope.decorator.spec.ts`).

- [ ] 4. **Create the response envelope interceptor** in `src/common/interceptors/response-envelope.interceptor.ts`.
      - Implement NestJS `NestInterceptor` that wraps every successful (non-streaming) response in `{ data: <original>, meta: {}, requestId: <id from req header> }`.
      - Use `Reflector` to check if the handler or controller has `NO_ENVELOPE` metadata; if present, skip wrapping.
      - Include idempotency guard: if the response is already an object with `data`, `meta`, and `requestId` keys, do not wrap again (return as-is).
      - Extract `requestId` from the request headers (`x-request-id`).
      Files: `src/common/interceptors/response-envelope.interceptor.ts`
      Verify: Unit tests pass (`npm test` for `src/common/interceptors/response-envelope.interceptor.spec.ts`).

- [ ] 5. **Wire the interceptor globally in AppModule**.
      - Add a provider with `provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor` to the `providers` array.
      Files: `src/app.module.ts`
      Verify: `npm run build` succeeds without errors.

- [ ] 6. **Write unit tests for RequestIdMiddleware** in `src/common/middleware/request-id.middleware.spec.ts`.
      - Test: When `x-request-id` header is absent, middleware generates a UUIDv4 and sets it on request and response headers.
      - Test: When `x-request-id` header is present, middleware forwards the existing value to request and response headers.
      - Test: Middleware binds requestId to the Pino logger context (verify `logger.assign` is called with the correct ID).
      Files: `src/common/middleware/request-id.middleware.spec.ts`
      Verify: `npm test` passes (all three test cases pass).

- [ ] 7. **Write unit tests for @NoEnvelope decorator** in `src/common/decorators/no-envelope.decorator.spec.ts`.
      - Test: Decorator sets the correct metadata key and value on a handler.
      - Test: Reflector can retrieve the metadata from a decorated handler.
      Files: `src/common/decorators/no-envelope.decorator.spec.ts`
      Verify: `npm test` passes (metadata tests pass).

- [ ] 8. **Write unit tests for ResponseEnvelopeInterceptor** in `src/common/interceptors/response-envelope.interceptor.spec.ts`.
      - Test: Wraps a plain object response in `{ data, meta: {}, requestId }`.
      - Test: Wraps an array response in `{ data, meta: {}, requestId }`.
      - Test: Skips wrapping when handler is decorated with `@NoEnvelope()`.
      - Test: Skips wrapping when response is already an envelope (has `data`, `meta`, and `requestId` keys).
      - Test: Uses the `x-request-id` from request headers as the `requestId` in the envelope.
      Files: `src/common/interceptors/response-envelope.interceptor.spec.ts`
      Verify: `npm test` passes (all five test cases pass).

- [ ] 9. **Run the full check suite and verify integration**.
      - Run `npm run check` to execute lint, build, and all unit tests.
      - Confirm all tests pass, including the new middleware, decorator, and interceptor tests.
      - Manually inspect a sample log line from a real request (start the dev server with `npm run start:dev`, make a request to `/api/v1/health`, check logs) to confirm the requestId appears in Pino log output.
      Files: N/A (verification only)
      Verify: `npm run check` passes with exit code 0. Logs from a real request show the requestId in every log line for that request.

## Verification Commands

- **Unit tests**: `npm test` (runs all `src/**/*.spec.ts`)
- **Build**: `npm run build` (compiles TypeScript)
- **Full check**: `npm run check` (lint + build + unit tests)
- **Manual integration check**: `npm run start:dev` → `curl http://localhost:4000/api/v1/health` → inspect logs and response headers for consistent requestId.

## Notes

- The middleware must run early in the request lifecycle, before any logging occurs, so the requestId is available to all downstream code.
- The interceptor must check for the `@NoEnvelope` decorator on both the handler and controller level (use `context.getHandler()` and `context.getClass()` with Reflector).
- The idempotency guard in the interceptor prevents double-wrapping if a service or controller method already returns an envelope shape.
- All error responses from `DomainExceptionFilter` already include `requestId` (from P0-03), so errors and success responses will have a consistent ID format.

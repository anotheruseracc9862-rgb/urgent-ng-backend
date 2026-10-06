# Implementation Plan: P0-03 — Error Framework

This plan implements a comprehensive error handling framework with domain exceptions, global filters, and proper error code mappings for the Urgent.ng backend.

## Context

The backend is a NestJS v12 ESM modular monolith with:
- TypeScript with ES modules (`"type": "module"` in package.json, `.js` extensions on imports)
- Vitest for unit tests (`npm test` runs `vitest run` on `src/**/*.spec.ts`)
- Pino logging via nestjs-pino
- PostgreSQL + Prisma ORM
- Global validation pipe and throttler guard already configured in `app.module.ts`
- Standard error response format from PRD §6.1: `{ "error": { "code": "...", "message": "...", "details": {} }, "requestId": "..." }`

The `src/common/` directory has placeholder subdirectories (exceptions/, filters/, constants/) currently containing only `.gitkeep` files.

## Design Decisions

**1. Exception hierarchy:** Create a single `DomainException` class extending NestJS `HttpException` with three properties: `code` (string), `httpStatus` (number), and `message` (safe, user-facing string). Other domain code throws this with appropriate values. No need for a deep hierarchy; the error code provides semantic distinction.

**2. Global filter:** A NestJS exception filter catches every unhandled exception and transforms it into the standard envelope. The filter handles three cases:
   - `DomainException`: use its code, status, and message directly
   - `PrismaClientKnownRequestError`: map specific Prisma error codes (P2002, P2003, P2025) to domain codes and HTTP statuses
   - All other errors: return 500 with code `INTERNAL_ERROR` and generic message, never exposing stack traces or internal details

**3. RequestId:** The filter reads `x-request-id` from the request headers (lowercase, as Express normalizes them) and includes it in every response. If missing, it returns `null` (the PRD shows requestId as a top-level field, not optional, so we always include it).

**4. Error codes:** Export all codes from PRD §31 as string constants in `src/common/constants/error-codes.ts`. Group by category for readability. Each constant is the code itself (e.g., `export const AUTH_REQUIRED = 'AUTH_REQUIRED'`).

**5. APP_FILTER wiring:** Register the filter globally in `AppModule` using the `APP_FILTER` provider pattern (same as the existing `APP_GUARD` for throttler).

---

## Implementation Steps

- [ ] 1. Create error code constants in `src/common/constants/error-codes.ts`.
      Export all 47 error codes from Backend PRD §31 as string constants, grouped by category: auth/account, general, errands, offers, assignments, verification, location/chat/ratings/safety, billing/media. Add `INTERNAL_ERROR` for unknown errors.
      Files: `src/common/constants/error-codes.ts`
      Verify: `npm run build` — the file compiles without errors.

- [ ] 2. Create the DomainException class in `src/common/exceptions/domain.exception.ts`.
      Extend NestJS `HttpException`. Constructor accepts `code: string`, `httpStatus: number`, and `message: string`. Store them as public readonly properties so the filter can read them. Pass `message` and `httpStatus` to the parent constructor.
      Files: `src/common/exceptions/domain.exception.ts`
      Verify: `npm run build` — the file compiles and DomainException can be instantiated.

- [ ] 3. Create the global exception filter in `src/common/filters/domain-exception.filter.ts`.
      Implement `@Catch()` decorator (catches all exceptions) with `ExceptionFilter` interface. In the `catch` method:
      - Extract `requestId` from `request.headers['x-request-id']` (or null)
      - If exception is `DomainException`, return `{ error: { code, message, details: {} }, requestId }` with its httpStatus
      - If exception is `PrismaClientKnownRequestError` (from `@prisma/client`), map:
        - P2002 (unique constraint) → code `RESOURCE_CONFLICT`, status 409, message "A resource with this value already exists."
        - P2003 (foreign key constraint) → code `VALIDATION_ERROR`, status 400, message "Invalid reference to a related resource."
        - P2025 (record not found) → code `RESOURCE_NOT_FOUND`, status 404, message "The requested resource was not found."
      - For all other exceptions, return code `INTERNAL_ERROR`, status 500, message "An unexpected error occurred. Please try again later.", with empty details. Never include stack traces or exception messages.
      - Use the Pino logger (inject `Logger` from nestjs-pino) to log the full exception details (including stack) for internal debugging, but never expose them in the response.
      Files: `src/common/filters/domain-exception.filter.ts`
      Verify: `npm run build` — the filter compiles and implements the ExceptionFilter interface correctly.

- [ ] 4. Wire the global exception filter in `src/app.module.ts`.
      Add `APP_FILTER` provider with `useClass: DomainExceptionFilter` to the `providers` array in `AppModule`, following the same pattern as the existing `APP_GUARD` provider for `ThrottlerGuard`. Import `DomainExceptionFilter` and `APP_FILTER` from `@nestjs/core`.
      Files: `src/app.module.ts`
      Verify: `npm run build` — the application compiles with the global filter registered.

- [ ] 5. Write unit tests for error-codes.ts in `src/common/constants/error-codes.spec.ts`.
      Test that all expected error code constants are exported and have the correct string values. Verify all 47 codes from PRD §31 plus `INTERNAL_ERROR` are present.
      Files: `src/common/constants/error-codes.spec.ts`
      Verify: `npm test` — all error-codes tests pass.

- [ ] 6. Write unit tests for DomainException in `src/common/exceptions/domain.exception.spec.ts`.
      Test that DomainException:
      - Stores code, httpStatus, and message as public properties
      - Extends HttpException correctly
      - Can be instantiated with various status codes and messages
      Files: `src/common/exceptions/domain.exception.spec.ts`
      Verify: `npm test` — all DomainException tests pass.

- [ ] 7. Write unit tests for DomainExceptionFilter in `src/common/filters/domain-exception.filter.spec.ts`.
      Test coverage:
      - DomainException returns its code, status, and message unchanged, with requestId from header
      - Prisma P2002 error maps to RESOURCE_CONFLICT (409) with safe message
      - Prisma P2003 error maps to VALIDATION_ERROR (400) with safe message
      - Prisma P2025 error maps to RESOURCE_NOT_FOUND (404) with safe message
      - Unknown exception returns INTERNAL_ERROR (500) with generic message and no stack trace
      - requestId is null when x-request-id header is missing
      - requestId is forwarded when x-request-id header is present
      Mock the response object's `status()` and `json()` methods, and verify they are called with correct arguments. Mock the logger to verify internal errors are logged but not exposed.
      Files: `src/common/filters/domain-exception.filter.spec.ts`
      Verify: `npm test` — all DomainExceptionFilter tests pass, covering all Prisma error mappings and the unknown error case.

- [ ] 8. Final verification: run the full check script.
      Run the project's pre-commit check that includes lint, build, and all unit tests. Confirm no regressions.
      Files: (none)
      Verify: `npm run check` (runs `npm run lint && npm run build && npm test`) — all steps pass without errors.

---

## Notes

- **ESM imports:** All imports must use `.js` extensions (e.g., `import { DomainException } from './domain.exception.js'`) per the project's ESM configuration.
- **Prisma imports:** `PrismaClientKnownRequestError` is imported from `@prisma/client/runtime/library.js` in ESM projects.
- **Testing strategy:** Unit tests use vitest with the globals setup (describe, it, expect are global). The test setup file (`test/setup.ts`) imports `reflect-metadata` for decorators. Mock NestJS `ArgumentsHost` and Express request/response objects for filter tests.
- **No production stack traces:** The filter logs the full exception internally but never includes stack traces or internal error messages in the JSON response, per PRD §6.1 ("Messages are safe and stable; internal details never leak").
- **Error details:** The `details` field in the error envelope is always an empty object `{}` in this implementation; domain services can extend DomainException in future to include structured details if needed.

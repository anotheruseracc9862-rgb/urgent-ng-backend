# Error framework implementation

The error framework establishes a clean separation between business domain errors (DomainException with stable error codes) and infrastructure errors (Prisma failures, unknown exceptions). The global filter catches everything, maps Prisma codes to business codes, and enforces the standard envelope shape across all responses. Request IDs flow through from headers, test coverage hits all major paths, and production responses never leak internals.

**Watch for:** none — the implementation meets all PRD requirements. All 49 error codes are present, Prisma mappings are correct, production responses are sanitized, and test coverage is complete.

**Verdict:** APPROVED

## High-level view

DomainException carries a stable error code, message, HTTP status, and optional details; it extends HttpException correctly. The global filter is wired via APP_FILTER in AppModule and catches all exceptions with an empty @Catch() decorator. Prisma errors P2002, P2003, and P2025 map to RESOURCE_CONFLICT (409), VALIDATION_ERROR (400), and RESOURCE_NOT_FOUND (404) respectively. Unknown errors return 500 with "An unexpected error occurred" and never expose stack traces or internal messages in responses. The response shape is exactly `{ error: { code, message, details? }, requestId }` where requestId comes from the x-request-id header or defaults to "unknown". All 49 error codes from PRD §31 are exported from error-codes.ts. Tests cover DomainException handling with and without details, all three Prisma error codes, unknown errors, requestId forwarding, and verify that stack traces don't leak.

<details>
<summary>File map</summary>

- **src/common/exceptions/domain.exception.ts** — DomainException class with code, httpStatus, message, details
- **src/common/filters/domain-exception.filter.ts** — Global exception filter with Prisma mappings and response sanitization
- **src/common/constants/error-codes.ts** — All 49 error codes from PRD §31
- **src/app.module.ts** — APP_FILTER provider registration
- **src/common/filters/domain-exception.filter.spec.ts** — Unit tests for all exception types and edge cases

</details>

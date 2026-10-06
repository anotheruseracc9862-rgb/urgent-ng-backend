# Rate Limiting (P1-07)

Rate limiting implementation using NestJS Throttler with Redis storage for distributed rate limiting across multiple API instances.

## Policies

Named policies per PRD §6.6:

| Policy | Limit | Window |
|--------|-------|--------|
| `auth` | 5 requests | 1 minute |
| `otp` | 10 requests | 1 hour |
| `feed` | 60 requests | 1 minute |
| `location` | 2 requests | 1 minute |
| `public-token` | 30 requests | 1 minute |
| `global` | 300 requests | 1 minute (default) |

## Usage

Apply a named policy to a route:

```typescript
import { RateLimit } from './common/decorators/rate-limit.decorator';

@Controller('auth')
export class AuthController {
  @Post('login')
  @RateLimit('auth')  // 5 per minute
  async login() {
    // ...
  }

  @Post('send-otp')
  @RateLimit('otp')  // 10 per hour
  async sendOtp() {
    // ...
  }
}
```

Routes without an explicit `@RateLimit()` decorator use the global policy (300 per minute).

## Redis storage

Counters live in Redis (`RedisThrottlerStorage`, an atomic Lua fixed-window counter), so limits hold across API instances and restarts. `AppThrottlerModule` wires it and `AppThrottlerGuard` is the global guard. If Redis is down the storage **fails open** (requests are allowed and a warning is logged): rate limiting must never take the API down.

## Response

Rate-limited requests return:
- **Status:** `429 Too Many Requests`
- **Error Code:** `RATE_LIMITED`
- **Headers:**
  - `X-RateLimit-Limit`: Maximum requests allowed
  - `X-RateLimit-Remaining`: Requests remaining in current window
  - `X-RateLimit-Reset`: Unix timestamp when the limit resets

## Testing

Rate limits are enforced in integration tests against real Redis (DB 15). See `rate-limit.int-spec.ts` and `redis-throttler.storage.int-spec.ts`.

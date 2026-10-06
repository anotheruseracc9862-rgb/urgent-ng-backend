# Rate Limiting (P1-07)

Rate limiting implementation using NestJS Throttler with Redis storage for distributed rate limiting across multiple API instances.

## Policies

Named policies per PRD §6.6:

| Policy | Limit | Window |
|--------|-------|--------|
| `auth` | 5 requests | 15 minutes |
| `otp` | 3 requests | 1 hour |
| `feed` | 30 requests | 1 minute |
| `location` | 2 requests | 1 minute |
| `public-token` | 10 requests | 1 minute |
| `global` | 300 requests | 1 minute (default) |

## Usage

Apply a named policy to a route:

```typescript
import { RateLimit } from './common/decorators/rate-limit.decorator';

@Controller('auth')
export class AuthController {
  @Post('login')
  @RateLimit('auth')  // 5 per 15 minutes
  async login() {
    // ...
  }

  @Post('send-otp')
  @RateLimit('otp')  // 3 per hour
  async sendOtp() {
    // ...
  }
}
```

Routes without an explicit `@RateLimit()` decorator use the global policy (300 per minute).

## Redis Storage (Production)

**Current Status:** Using in-memory storage (development only).

**For production:** Install and configure Redis storage to ensure rate limits hold across multiple API instances:

```bash
npm install throttler-storage-redis
```

Update `app.module.ts`:

```typescript
import { ThrottlerStorageRedisService } from 'throttler-storage-redis';
import Redis from 'ioredis';

ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    throttlers: [{ ttl: 60_000, limit: 300 }],
    storage: new ThrottlerStorageRedisService(
      new Redis(config.getOrThrow<string>('redis.url'))
    ),
  }),
}),
```

## Response

Rate-limited requests return:
- **Status:** `429 Too Many Requests`
- **Error Code:** `RATE_LIMIT_EXCEEDED`
- **Headers:**
  - `X-RateLimit-Limit`: Maximum requests allowed
  - `X-RateLimit-Remaining`: Requests remaining in current window
  - `X-RateLimit-Reset`: Unix timestamp when the limit resets

## Testing

Rate limits are enforced in integration tests but disabled in unit tests. See `rate-limit.int-spec.ts` for examples.

import type { ProviderMode } from './env.validation.js';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  corsOrigins: string[];
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  jwt: {
    secret: string;
    refreshSecret: string;
  };
  security: {
    dataEncryptionKey: string;
    hmacSecret: string;
    otpHmacSecret: string;
    blocklistHmacSecret: string;
  };
  dojah: {
    appId: string;
    secretKey: string;
    baseUrl: string;
  };
  providers: {
    kyc: ProviderMode;
    maps: ProviderMode;
    sms: ProviderMode;
    email: ProviderMode;
    push: ProviderMode;
    storage: ProviderMode;
    payments: ProviderMode;
  };
}

const mode = (value: string | undefined): ProviderMode =>
  value === 'real' ? 'real' : 'fake';

// Secrets default to a clearly fake value outside production so cursors and
// encrypted columns work locally. Production requires real values (see
// env.validation.ts) and never falls back to these.
const isProduction = process.env.NODE_ENV === 'production';
const devSecret = (name: string) =>
  isProduction ? '' : `development-only-${name}-not-for-production`;

export default (): AppConfig => ({
  nodeEnv:
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test'
      ? process.env.NODE_ENV
      : 'development',
  port: Number.parseInt(process.env.PORT ?? '4000', 10),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? '',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
  },
  security: {
    dataEncryptionKey:
      process.env.DATA_ENCRYPTION_KEY || devSecret('data-encryption-key'),
    hmacSecret: process.env.HMAC_SECRET || devSecret('hmac-secret'),
    otpHmacSecret:
      process.env.OTP_HMAC_SECRET || devSecret('otp-hmac-secret'),
    blocklistHmacSecret:
      process.env.BLOCKLIST_HMAC_SECRET || devSecret('blocklist-hmac-secret'),
  },
  dojah: {
    appId: process.env.DOJAH_APP_ID ?? '',
    secretKey: process.env.DOJAH_SECRET_KEY ?? '',
    baseUrl: process.env.DOJAH_BASE_URL ?? '',
  },
  providers: {
    kyc: mode(process.env.KYC_PROVIDER),
    maps: mode(process.env.MAPS_PROVIDER),
    sms: mode(process.env.SMS_PROVIDER),
    email: mode(process.env.EMAIL_PROVIDER),
    push: mode(process.env.PUSH_PROVIDER),
    storage: mode(process.env.STORAGE_PROVIDER),
    payments: mode(process.env.PAYMENTS_PROVIDER),
  },
});

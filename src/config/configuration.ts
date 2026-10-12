import { createHmac } from 'node:crypto';
import { resolveProviderMode, type ProviderMode } from './env.validation.js';

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
    adminSecret: string;
  };
  security: {
    dataEncryptionKey: string;
    hmacSecret: string;
  };
  dojah: {
    appId: string;
    secretKey: string;
    baseUrl: string;
  };
  paystack: {
    secretKey: string;
    webhookSecret: string;
    baseUrl: string;
    callbackUrl: string;
  };
  firebase: {
    credentials: string;
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
  };
  aws: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  };
  google: {
    clientId: string;
  };
  providers: {
    google: ProviderMode;
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
  resolveProviderMode(value, process.env.NODE_ENV) === 'real' ? 'real' : 'fake';

// Secrets default to a clearly fake value outside production so cursors and
// encrypted columns work locally. Production requires real values (see
// env.validation.ts) and never falls back to these.
const isProduction = process.env.NODE_ENV === 'production';
const devSecret = (name: string) =>
  isProduction ? '' : `development-only-${name}-not-for-production`;

export default (): AppConfig => {
  const jwtSecret = process.env.JWT_SECRET || devSecret('jwt-secret');
  return {
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
    secret: jwtSecret,
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
    // Admin tokens are signed with a key derived from the consumer secret, so one
    // secret to manage, yet a consumer token can never verify as an admin token.
    adminSecret: createHmac('sha256', jwtSecret).update('urgent-admin-jwt').digest('hex'),
  },
  security: {
    dataEncryptionKey:
      process.env.DATA_ENCRYPTION_KEY || devSecret('data-encryption-key'),
    hmacSecret: process.env.HMAC_SECRET || devSecret('hmac-secret'),
  },
  dojah: {
    appId: process.env.DOJAH_APP_ID ?? '',
    secretKey: process.env.DOJAH_SECRET_KEY ?? '',
    baseUrl: process.env.DOJAH_BASE_URL ?? '',
  },
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY ?? '',
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET ?? '',
    baseUrl: process.env.PAYSTACK_BASE_URL ?? 'https://api.paystack.co',
    callbackUrl: process.env.PAYSTACK_CALLBACK_URL ?? '',
  },
  firebase: {
    credentials: process.env.FIREBASE_CREDENTIALS ?? '',
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number.parseInt(process.env.SMTP_PORT ?? '465', 10),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.MAIL_FROM ?? '',
  },
  aws: {
    region: process.env.AWS_REGION ?? '',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    bucket: process.env.AWS_S3_BUCKET ?? '',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
  },
  providers: {
    google: mode(process.env.GOOGLE_AUTH_PROVIDER),
    kyc: mode(process.env.KYC_PROVIDER),
    maps: mode(process.env.MAPS_PROVIDER),
    sms: mode(process.env.SMS_PROVIDER),
    email: mode(process.env.EMAIL_PROVIDER),
    push: mode(process.env.PUSH_PROVIDER),
    storage: mode(process.env.STORAGE_PROVIDER),
    payments: mode(process.env.PAYMENTS_PROVIDER),
  },
};
};


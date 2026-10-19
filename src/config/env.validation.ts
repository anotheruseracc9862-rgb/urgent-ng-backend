import { plainToInstance, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';

export type ProviderMode = 'fake' | 'real';

const isProduction = (env: EnvironmentVariables): boolean =>
  env.NODE_ENV === 'production';

// The automated tests (NODE_ENV=test) run on in-process stand-ins and need no vendor keys; every
// other environment uses the vendors and needs their keys.
const usesVendors = (env: EnvironmentVariables): boolean => env.NODE_ENV !== 'test';
const usesRealKyc = usesVendors;
const usesRealEmail = usesVendors;
const usesRealPush = usesVendors;
const usesRealStorage = usesVendors;

// Outside production an empty SMS key means "no SMS vendor yet": codes are logged (LogOtpProvider).
const needsSmsKeys = (env: EnvironmentVariables): boolean => isProduction(env);
const usesRealMaps = usesVendors;
const usesRealPayments = usesVendors;
const usesRealGoogle = usesVendors;

/**
 * Environment contract. Validated once at boot (fail fast) so a misconfigured
 * deployment never starts half-working. Secrets are only length-checked in
 * production so local development works with the .env.example placeholders.
 */
export class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 4000;

  @Matches(/^postgres(ql)?:\/\//, {
    message: 'DATABASE_URL must start with postgresql:// or postgres://',
  })
  DATABASE_URL!: string;

  @Matches(/^rediss?:\/\//, {
    message: 'REDIS_URL must start with redis:// or rediss://',
  })
  REDIS_URL: string = 'redis://localhost:6379';

  @IsString()
  CORS_ORIGINS: string = 'http://localhost:4001,http://localhost:4002';

  /** The public address of the web app. Links in emails start here. */
  @ValidateIf(isProduction)
  @Matches(/^https:\/\//, { message: 'WEB_APP_URL must be the public https address of the web app in production' })
  WEB_APP_URL?: string;

  /** The public address of this backend. The email logo is served from it. */
  @ValidateIf(isProduction)
  @Matches(/^https:\/\//, { message: 'API_PUBLIC_URL must be the public https address of this backend in production' })
  API_PUBLIC_URL?: string;

  @ValidateIf(isProduction)
  @IsString()
  @MinLength(32, {
    message: 'JWT_SECRET must be at least 32 characters in production',
  })
  JWT_SECRET?: string;

  @ValidateIf(isProduction)
  @IsString()
  @MinLength(32, {
    message: 'JWT_REFRESH_SECRET must be at least 32 characters in production',
  })
  JWT_REFRESH_SECRET?: string;

  @ValidateIf(isProduction)
  @IsString()
  @MinLength(32, {
    message: 'DATA_ENCRYPTION_KEY must be at least 32 characters in production',
  })
  DATA_ENCRYPTION_KEY?: string;

  @ValidateIf(isProduction)
  @IsString()
  @MinLength(32, {
    message: 'HMAC_SECRET must be at least 32 characters in production',
  })
  HMAC_SECRET?: string;

  // Dojah credentials are only required when the KYC provider is "real".
  @ValidateIf(usesRealKyc)
  @IsString()
  @IsNotEmpty()
  DOJAH_APP_ID?: string;

  @ValidateIf(usesRealKyc)
  @IsString()
  @IsNotEmpty()
  DOJAH_SECRET_KEY?: string;

  @ValidateIf(usesRealKyc)
  @IsString()
  @IsNotEmpty()
  DOJAH_BASE_URL?: string;

  // A server key with the Geocoding and Distance Matrix APIs enabled.
  @ValidateIf(usesRealMaps)
  @IsString()
  @IsNotEmpty()
  MAPS_API_KEY?: string;

  @ValidateIf(usesRealGoogle)
  @IsString()
  @IsNotEmpty()
  GOOGLE_CLIENT_ID?: string;

  // Termii: the API key and the registered sender id. Email codes go through the SMTP settings.
  // Required in production; empty elsewhere means the code is written to the backend log.
  @ValidateIf(needsSmsKeys)
  @IsString()
  @IsNotEmpty()
  SMS_API_KEY?: string;

  @ValidateIf(needsSmsKeys)
  @IsString()
  @IsNotEmpty()
  SMS_SENDER_ID?: string;

  // SMTP settings (any SMTP service: Resend, Mailgun...) are only required when the email provider is "real".
  @ValidateIf(usesRealEmail)
  @IsString()
  @IsNotEmpty()
  MAIL_FROM?: string;

  @ValidateIf(usesRealEmail)
  @IsString()
  @IsNotEmpty()
  SMTP_HOST?: string;

  @ValidateIf(usesRealEmail)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT?: number;

  @ValidateIf(usesRealEmail)
  @IsString()
  @IsNotEmpty()
  SMTP_USER?: string;

  @ValidateIf(usesRealEmail)
  @IsString()
  @IsNotEmpty()
  SMTP_PASS?: string;

  // The Firebase service account (JSON, or the same JSON base64-encoded), only when push is "real".
  @ValidateIf(usesRealPush)
  @IsString()
  @IsNotEmpty()
  FIREBASE_CREDENTIALS?: string;

  // S3 settings are only required when the storage provider is "real".
  @ValidateIf(usesRealStorage)
  @IsString()
  @IsNotEmpty()
  AWS_REGION?: string;

  @ValidateIf(usesRealStorage)
  @IsString()
  @IsNotEmpty()
  AWS_S3_BUCKET?: string;

  @ValidateIf(usesRealStorage)
  @IsString()
  @IsNotEmpty()
  AWS_ACCESS_KEY_ID?: string;

  @ValidateIf(usesRealStorage)
  @IsString()
  @IsNotEmpty()
  AWS_SECRET_ACCESS_KEY?: string;

  @ValidateIf(usesRealPayments)
  @IsString()
  @IsNotEmpty()
  PAYSTACK_SECRET_KEY?: string;
}

export function validateEnv(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = plainToInstance(EnvironmentVariables, raw);
  const errors = validateSync(parsed, { whitelist: false });
  if (errors.length > 0) {
    const lines = errors.flatMap((error) =>
      Object.values(error.constraints ?? {}).map((message) => `  - ${error.property}: ${message}`),
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return raw;
}

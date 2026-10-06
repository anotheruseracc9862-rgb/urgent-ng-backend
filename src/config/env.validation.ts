import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';

export const PROVIDER_MODES = ['fake', 'real'] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

const isProduction = (env: EnvironmentVariables): boolean =>
  env.NODE_ENV === 'production';

const usesRealKyc = (env: EnvironmentVariables): boolean =>
  env.KYC_PROVIDER === 'real';

const defaultToFake =({ value }: { value: unknown }) => value || 'fake';

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
  CORS_ORIGINS: string = 'http://localhost:3001';

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

  @ValidateIf(isProduction)
  @IsString()
  @MinLength(32, {
    message: 'OTP_HMAC_SECRET must be at least 32 characters in production',
  })
  OTP_HMAC_SECRET?: string;

  @ValidateIf(isProduction)
  @IsString()
  @MinLength(32, {
    message: 'BLOCKLIST_HMAC_SECRET must be at least 32 characters in production',
  })
  BLOCKLIST_HMAC_SECRET?: string;

  // Provider modes: "fake" (default) uses in-process fakes, "real" calls the vendor.
  @IsOptional()
  @Transform(defaultToFake)
  @IsIn(PROVIDER_MODES)
  KYC_PROVIDER: ProviderMode = 'fake';

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

  @IsOptional()
  @Transform(defaultToFake)
  @IsIn(PROVIDER_MODES)
  MAPS_PROVIDER: ProviderMode = 'fake';

  @IsOptional()
  @Transform(defaultToFake)
  @IsIn(PROVIDER_MODES)
  SMS_PROVIDER: ProviderMode = 'fake';

  @IsOptional()
  @Transform(defaultToFake)
  @IsIn(PROVIDER_MODES)
  EMAIL_PROVIDER: ProviderMode = 'fake';

  @IsOptional()
  @Transform(defaultToFake)
  @IsIn(PROVIDER_MODES)
  PUSH_PROVIDER: ProviderMode = 'fake';

  @IsOptional()
  @Transform(defaultToFake)
  @IsIn(PROVIDER_MODES)
  STORAGE_PROVIDER: ProviderMode = 'fake';

  @IsOptional()
  @Transform(defaultToFake)
  @IsIn(PROVIDER_MODES)
  PAYMENTS_PROVIDER: ProviderMode = 'fake';
}

export function validateEnv(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = plainToInstance(EnvironmentVariables, raw);
  const errors = validateSync(parsed, { whitelist: false });
  if (errors.length > 0) {
    const lines = errors.flatMap((error) =>
      Object.values(error.constraints ?? {}).map(
        (message) => `  - ${error.property}: ${message}`,
      ),
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return raw;
}

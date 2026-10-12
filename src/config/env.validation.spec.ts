import { validateEnv } from './env.validation.js';

// Under NODE_ENV=test every vendor defaults to its fake, so a minimal environment is enough.
const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://urgent:urgent@localhost:5544/urgent_ng',
};

const longSecret = 'x'.repeat(32);
const productionSecrets = {
  JWT_SECRET: longSecret,
  JWT_REFRESH_SECRET: longSecret,
  DATA_ENCRYPTION_KEY: longSecret,
  HMAC_SECRET: longSecret,
};

// Every vendor's keys: what a real environment (development or production) provides.
const vendors = {
  DOJAH_APP_ID: 'app',
  DOJAH_SECRET_KEY: 'secret',
  DOJAH_BASE_URL: 'https://api.dojah.io',
  MAIL_FROM: 'Urgent.ng <a@b.ng>',
  SMTP_HOST: 'smtp.resend.com',
  SMTP_PORT: '465',
  SMTP_USER: 'resend',
  SMTP_PASS: 'secret',
  FIREBASE_CREDENTIALS: '{"project_id":"p"}',
  AWS_REGION: 'us-east-1',
  AWS_S3_BUCKET: 'bucket',
  AWS_ACCESS_KEY_ID: 'id',
  AWS_SECRET_ACCESS_KEY: 'secret',
  MAPS_API_KEY: 'maps-key',
  GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com',
  SMS_API_KEY: 'sms-key',
  SMS_SENDER_ID: 'Urgent',
  PAYSTACK_SECRET_KEY: 'sk_test_x',
};

describe('validateEnv', () => {
  it('accepts a minimal development environment', () => {
    expect(() => validateEnv(valid)).not.toThrow();
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a DATABASE_URL that is not postgres', () => {
    expect(() => validateEnv({ DATABASE_URL: 'mysql://x' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a non-redis REDIS_URL', () => {
    expect(() => validateEnv({ ...valid, REDIS_URL: 'http://x' })).toThrow(
      /REDIS_URL/,
    );
  });

  it('rejects an invalid PORT', () => {
    expect(() => validateEnv({ ...valid, PORT: '99999' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...valid, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('needs the SMTP settings outside the automated tests', () => {
    expect(() => validateEnv({ ...valid })).not.toThrow();
    expect(() => validateEnv({ DATABASE_URL: valid.DATABASE_URL, NODE_ENV: 'development', ...vendors, SMTP_HOST: '' })).toThrow(/SMTP_HOST/);
    expect(() => validateEnv({ DATABASE_URL: valid.DATABASE_URL, NODE_ENV: 'development', ...vendors })).not.toThrow();
  });

  it('does not require secrets outside production', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'test' })).not.toThrow();
    expect(() => validateEnv({ ...valid, NODE_ENV: 'development', ...vendors })).not.toThrow();
  });

  it('runs development with real vendors, so it asks for their keys', () => {
    let message = '';
    try {
      validateEnv({ DATABASE_URL: valid.DATABASE_URL, NODE_ENV: 'development' });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of ['DOJAH_APP_ID', 'SMTP_HOST', 'AWS_REGION', 'MAPS_API_KEY', 'GOOGLE_CLIENT_ID', 'PAYSTACK_SECRET_KEY']) {
      expect(message, name).toContain(name);
    }
  });

  it('lets development run without SMS keys (the code is logged) but not production', () => {
    const { SMS_API_KEY: _a, SMS_SENDER_ID: _b, ...withoutSms } = vendors;
    expect(() => validateEnv({ DATABASE_URL: valid.DATABASE_URL, NODE_ENV: 'development', ...withoutSms })).not.toThrow();
    expect(() => validateEnv({ DATABASE_URL: valid.DATABASE_URL, NODE_ENV: 'production', ...productionSecrets, ...withoutSms })).toThrow(/SMS_API_KEY/);
  });

  it('requires long secrets in production and names every missing one', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'production' })).toThrow(
      /JWT_SECRET[\s\S]*JWT_REFRESH_SECRET[\s\S]*DATA_ENCRYPTION_KEY[\s\S]*HMAC_SECRET/,
    );
  });

  it('rejects short secrets in production', () => {
    expect(() =>
      validateEnv({
        ...valid,
        ...productionSecrets,
        NODE_ENV: 'production',
        JWT_SECRET: 'short',
      }),
    ).toThrow(/JWT_SECRET/);
  });

  const productionVendors = vendors;

  it('accepts a complete production environment', () => {
    expect(() =>
      validateEnv({ ...valid, ...productionSecrets, ...productionVendors, NODE_ENV: 'production' }),
    ).not.toThrow();
  });

  it('asks production for the vendor keys', () => {
    let message = '';
    try {
      validateEnv({ ...valid, ...productionSecrets, NODE_ENV: 'production' });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of ['DOJAH_APP_ID', 'SMTP_HOST', 'AWS_REGION', 'SMS_API_KEY', 'MAPS_API_KEY', 'PAYSTACK_SECRET_KEY']) {
      expect(message, name).toContain(name);
    }
  });

  it('ignores a provider switch in the environment: there is none', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: valid.DATABASE_URL, NODE_ENV: 'development', SMS_PROVIDER: 'fake', KYC_PROVIDER: 'fake' }),
    ).toThrow(/DOJAH_APP_ID/);
  });
});

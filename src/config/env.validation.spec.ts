import { validateEnv } from './env.validation.js';

const valid = {
  DATABASE_URL: 'postgresql://urgent:urgent@localhost:5544/urgent_ng',
};

const longSecret = 'x'.repeat(32);
const productionSecrets = {
  JWT_SECRET: longSecret,
  JWT_REFRESH_SECRET: longSecret,
  DATA_ENCRYPTION_KEY: longSecret,
  HMAC_SECRET: longSecret,
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

  it('rejects an unknown provider mode', () => {
    expect(() => validateEnv({ ...valid, KYC_PROVIDER: 'maybe' })).toThrow(
      /KYC_PROVIDER/,
    );
  });

  it('needs the SMTP settings only when EMAIL_PROVIDER=real', () => {
    expect(() => validateEnv({ ...valid, EMAIL_PROVIDER: 'fake' })).not.toThrow();
    expect(() => validateEnv({ ...valid, EMAIL_PROVIDER: 'real' })).toThrow(/SMTP_HOST/);
    expect(() =>
      validateEnv({
        ...valid,
        EMAIL_PROVIDER: 'real',
        MAIL_FROM: 'Urgent.ng <a@b.ng>',
        SMTP_HOST: 'smtp.mailgun.org',
        SMTP_PORT: '465',
        SMTP_USER: 'postmaster@mg.example.ng',
        SMTP_PASS: 'secret',
      }),
    ).not.toThrow();
  });

  it('treats an empty provider mode as fake', () => {
    expect(() => validateEnv({ ...valid, SMS_PROVIDER: '' })).not.toThrow();
  });

  it('does not require secrets outside production', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'development' })).not.toThrow();
    expect(() => validateEnv({ ...valid, NODE_ENV: 'test' })).not.toThrow();
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

  const productionVendors = {
    DOJAH_APP_ID: 'app',
    DOJAH_SECRET_KEY: 'secret',
    DOJAH_BASE_URL: 'https://api.dojah.io',
    MAIL_FROM: 'Urgent.ng <a@b.ng>',
    SMTP_HOST: 'smtp.resend.com',
    SMTP_PORT: '465',
    SMTP_USER: 'resend',
    SMTP_PASS: 'secret',
    AWS_REGION: 'us-east-1',
    AWS_S3_BUCKET: 'bucket',
    AWS_ACCESS_KEY_ID: 'id',
    AWS_SECRET_ACCESS_KEY: 'secret',
  };

  it('accepts a complete production environment, with every vendor real by default', () => {
    expect(() =>
      validateEnv({ ...valid, ...productionSecrets, ...productionVendors, NODE_ENV: 'production' }),
    ).not.toThrow();
  });

  it('asks production for vendor keys when no provider mode is set', () => {
    expect(() =>
      validateEnv({ ...valid, ...productionSecrets, NODE_ENV: 'production' }),
    ).toThrow(/DOJAH_APP_ID[\s\S]*SMTP_HOST[\s\S]*AWS_REGION/);
  });

  it('refuses a fake provider in production', () => {
    expect(() =>
      validateEnv({
        ...valid,
        ...productionSecrets,
        ...productionVendors,
        NODE_ENV: 'production',
        SMS_PROVIDER: 'fake',
      }),
    ).toThrow(/SMS_PROVIDER: must not be "fake" in production/);
  });

  it('lets development try a live vendor with an explicit mode', () => {
    expect(() => validateEnv({ ...valid, STORAGE_PROVIDER: 'real' })).toThrow(/AWS_REGION/);
  });

  it('does not require Dojah credentials while KYC runs on the fake provider', () => {
    expect(() => validateEnv({ ...valid, KYC_PROVIDER: 'fake' })).not.toThrow();
  });

  it('requires Dojah credentials when KYC_PROVIDER is real', () => {
    expect(() => validateEnv({ ...valid, KYC_PROVIDER: 'real' })).toThrow(
      /DOJAH_APP_ID[\s\S]*DOJAH_SECRET_KEY[\s\S]*DOJAH_BASE_URL/,
    );
  });

  it('accepts a complete real Dojah configuration', () => {
    expect(() =>
      validateEnv({
        ...valid,
        KYC_PROVIDER: 'real',
        DOJAH_APP_ID: 'app',
        DOJAH_SECRET_KEY: 'secret',
        DOJAH_BASE_URL: 'https://sandbox.dojah.io',
      }),
    ).not.toThrow();
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });
});

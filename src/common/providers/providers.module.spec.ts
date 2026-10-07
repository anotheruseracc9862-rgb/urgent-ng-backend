/**
 * Providers module tests
 */

import { describe, it, expect } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ProvidersModule } from './providers.module.js';
import {
  OTP_PROVIDER,
  KYC_PROVIDER,
  STORAGE_PROVIDER,
  MAPS_PROVIDER,
  PUSH_PROVIDER,
  EMAIL_PROVIDER,
  PAYMENT_PROVIDER,
} from './index.js';
import { S3StorageProvider } from './s3-storage.provider.js';
import { DojahKycProvider } from './dojah-kyc.provider.js';
import {
  FakeOtpProvider,
  FakeKycProvider,
  FakeStorageProvider,
  FakeMapsProvider,
  FakePushProvider,
  FakeEmailProvider,
  FakePaymentProvider,
  FAKE_VALID_WEBHOOK_SIGNATURE,
} from './fakes/index.js';

const allFake = {
  kyc: 'fake',
  maps: 'fake',
  sms: 'fake',
  email: 'fake',
  push: 'fake',
  storage: 'fake',
  payments: 'fake',
};

async function build(providers: Record<string, string>): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        // Same shape as AppConfig.providers (see src/config/configuration.ts)
        load: [() => ({ providers })],
      }),
      ProvidersModule.forRoot(),
    ],
  }).compile();
}

describe('ProvidersModule', () => {
  it('provides fake implementations when every mode is fake', async () => {
    const module = await build(allFake);

    expect(module.get(OTP_PROVIDER)).toBeInstanceOf(FakeOtpProvider);
    expect(module.get(KYC_PROVIDER)).toBeInstanceOf(FakeKycProvider);
    expect(module.get(STORAGE_PROVIDER)).toBeInstanceOf(FakeStorageProvider);
    expect(module.get(MAPS_PROVIDER)).toBeInstanceOf(FakeMapsProvider);
    expect(module.get(PUSH_PROVIDER)).toBeInstanceOf(FakePushProvider);
    expect(module.get(EMAIL_PROVIDER)).toBeInstanceOf(FakeEmailProvider);
    expect(module.get(PAYMENT_PROVIDER)).toBeInstanceOf(FakePaymentProvider);
  });

  it('defaults to fake when no mode is configured', async () => {
    const module = await build({});

    expect(module.get(KYC_PROVIDER)).toBeInstanceOf(FakeKycProvider);
  });

  it.each([
    ['sms', OTP_PROVIDER, 'SMS_PROVIDER=real'],
    ['maps', MAPS_PROVIDER, 'MAPS_PROVIDER=real'],
    ['push', PUSH_PROVIDER, 'PUSH_PROVIDER=real'],
    ['email', EMAIL_PROVIDER, 'EMAIL_PROVIDER=real'],
    ['payments', PAYMENT_PROVIDER, 'PAYMENTS_PROVIDER=real'],
  ])(
    'fails fast instead of silently using a fake when %s is "real" but not implemented',
    async (name, token, message) => {
      // Provider factories run at module compile time, so a bad setting stops boot.
      await expect(build({ ...allFake, [name]: 'real' })).rejects.toThrow(message);
      void token;
    },
  );

  it('fails fast when storage is "real" but the AWS settings are missing', async () => {
    await expect(build({ ...allFake, storage: 'real' })).rejects.toThrow('STORAGE_PROVIDER=real');
  });

  it('builds the S3 provider when storage is "real" and the AWS settings are present', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              providers: { ...allFake, storage: 'real' },
              aws: { region: 'eu-west-1', bucket: 'b', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
            }),
          ],
        }),
        ProvidersModule.forRoot(),
      ],
    }).compile();

    expect(module.get(STORAGE_PROVIDER)).toBeInstanceOf(S3StorageProvider);
  });

  it('signs the S3 upload URL with the declared type and size', async () => {
    const s3 = new S3StorageProvider({ region: 'eu-west-1', bucket: 'b', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' });

    const upload = await s3.createPresignedUpload({ key: 'media/u/p/1/original.jpg', contentType: 'image/jpeg', maxBytes: 1234, expiresInSeconds: 600 });

    expect(upload.url).toContain('media/u/p/1/original.jpg');
    expect(upload.url).toMatch(/X-Amz-SignedHeaders=[^&]*content-length/i);
    expect(upload.url).toMatch(/X-Amz-SignedHeaders=[^&]*content-type/i);
    expect(upload.url).toContain('X-Amz-Expires=600');
  });

  it('fails fast when KYC is "real" but the Dojah settings are missing', async () => {
    await expect(build({ ...allFake, kyc: 'real' })).rejects.toThrow('KYC_PROVIDER=real');
  });

  it('builds the Dojah provider when KYC is "real" and the settings are present', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ providers: { ...allFake, kyc: 'real' }, dojah: { appId: 'a', secretKey: 's', baseUrl: 'https://sandbox.dojah.io' } })],
        }),
        ProvidersModule.forRoot(),
      ],
    }).compile();

    expect(module.get(KYC_PROVIDER)).toBeInstanceOf(DojahKycProvider);
  });

  it('records calls to fake providers', async () => {
    const module = await build(allFake);
    const otpProvider = module.get(OTP_PROVIDER) as FakeOtpProvider;

    await otpProvider.sendSms('+2348012345678', '123456');

    const calls = otpProvider.getCalls('sendSms');
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe('+2348012345678');
    expect(calls[0].args[1]).toBe('123456');
  });
});

describe('FakeKycProvider (NIN + selfie)', () => {
  const provider = new FakeKycProvider();
  const selfie = 'ZmFrZS1zZWxmaWU=';

  it('verifies by default with confidence 99', async () => {
    const result = await provider.verifyNinWithSelfie({ nin: '12345678901', selfieImageBase64: selfie });

    expect(result).toMatchObject({ outcome: 'VERIFIED', confidence: 99, countsAgainstAllowance: true });
    expect(result.maskedAttributes).toEqual({ ninLast4: '8901' });
  });

  it.each([
    ['00000000000', 'SELFIE_MISMATCH', true],
    ['11111111111', 'IDENTITY_MISMATCH', true],
    ['88888888888', 'PROVIDER_TIMEOUT', false],
    ['99999999999', 'PROVIDER_ERROR', false],
  ])('maps NIN %s to %s (counts against allowance: %s)', async (nin, reason, counts) => {
    const result = await provider.verifyNinWithSelfie({ nin, selfieImageBase64: selfie });

    expect(result.outcome).toBe('FAILED');
    expect(result.failureReason).toBe(reason);
    expect(result.countsAgainstAllowance).toBe(counts);
  });

  it('never records the full NIN or the selfie in the call log', async () => {
    const fake = new FakeKycProvider();
    await fake.verifyNinWithSelfie({ nin: '12345678901', selfieImageBase64: selfie });

    const logged = JSON.stringify(fake.getCalls());
    expect(logged).not.toContain('12345678901');
    expect(logged).not.toContain(selfie);
  });

  it('supports scripted outcomes', async () => {
    const fake = new FakeKycProvider();
    fake.scriptOutcomes('verifyNinWithSelfie', [
      { outcome: 'FAILED', failureReason: 'DOCUMENT_INVALID', countsAgainstAllowance: true },
    ]);

    const result = await fake.verifyNinWithSelfie({ nin: '12345678901', selfieImageBase64: selfie });

    expect(result.failureReason).toBe('DOCUMENT_INVALID');
  });
});

describe('FakeStorageProvider (presigned flow)', () => {
  it('walks the upload, confirm, download and delete flow without bytes passing through the API', async () => {
    const storage = new FakeStorageProvider();

    const upload = await storage.createPresignedUpload({
      key: 'errands/1.jpg',
      contentType: 'image/jpeg',
      maxBytes: 100,
      expiresInSeconds: 300,
    });
    expect(upload.method).toBe('PUT');
    expect(upload.headers['Content-Type']).toBe('image/jpeg');

    expect(await storage.headObject('errands/1.jpg')).toEqual({ exists: false });

    storage.simulateClientUpload('errands/1.jpg', Buffer.from('jpeg-bytes'), 'image/jpeg');
    expect(await storage.headObject('errands/1.jpg')).toEqual({
      exists: true,
      sizeBytes: 10,
      contentType: 'image/jpeg',
    });

    const download = await storage.createPresignedDownload('errands/1.jpg', 60);
    expect(download.url).toContain('errands/1.jpg');

    await storage.deleteObject('errands/1.jpg');
    expect((await storage.headObject('errands/1.jpg')).exists).toBe(false);
  });

  it('enforces the size limit that the presigned URL would enforce', async () => {
    const storage = new FakeStorageProvider();
    await storage.createPresignedUpload({ key: 'k', contentType: 'image/png', maxBytes: 5, expiresInSeconds: 60 });

    expect(() => storage.simulateClientUpload('k', Buffer.alloc(6), 'image/png')).toThrow('size limit');
  });

  it('lets workers read and write objects', async () => {
    const storage = new FakeStorageProvider();
    await storage.putObject('processed/1.webp', Buffer.from('x'), 'image/webp');

    expect((await storage.getObject('processed/1.webp')).toString()).toBe('x');
    await expect(storage.getObject('missing')).rejects.toThrow('not found');
  });
});

describe('FakePaymentProvider (Paystack)', () => {
  it('only reports success after the customer pays, and exposes the card authorisation', async () => {
    const payments = new FakePaymentProvider();
    await payments.initializeTransaction({ email: 'a@b.ng', amountKobo: 500000, reference: 'ref-1' });

    expect((await payments.verifyTransaction('ref-1')).status).toBe('pending');

    payments.markPaid('ref-1', 'AUTH_x');
    const verified = await payments.verifyTransaction('ref-1');
    expect(verified).toMatchObject({ status: 'success', amountKobo: 500000, authorizationCode: 'AUTH_x' });
  });

  it('treats an unknown reference as abandoned', async () => {
    const payments = new FakePaymentProvider();

    expect((await payments.verifyTransaction('nope')).status).toBe('abandoned');
  });

  it('charges a saved authorisation for auto-renewal', async () => {
    const payments = new FakePaymentProvider();
    const result = await payments.chargeAuthorization({
      email: 'a@b.ng',
      authorizationCode: 'AUTH_x',
      amountKobo: 500000,
      reference: 'renew-1',
    });

    expect(result.status).toBe('success');
  });

  it('verifies webhook signatures', () => {
    const payments = new FakePaymentProvider();

    expect(payments.verifyWebhookSignature('{}', FAKE_VALID_WEBHOOK_SIGNATURE)).toBe(true);
    expect(payments.verifyWebhookSignature('{}', 'forged')).toBe(false);
  });
});

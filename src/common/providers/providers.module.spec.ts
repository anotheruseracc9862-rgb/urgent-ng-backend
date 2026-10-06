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
import { FakeOtpProvider, FakeKycProvider } from './fakes/index.js';

describe('ProvidersModule', () => {
  it('should provide fake implementations when mode is fake', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              SMS_PROVIDER_MODE: 'fake',
              KYC_PROVIDER_MODE: 'fake',
              STORAGE_PROVIDER_MODE: 'fake',
              MAPS_PROVIDER_MODE: 'fake',
              PUSH_PROVIDER_MODE: 'fake',
              EMAIL_PROVIDER_MODE: 'fake',
              PAYMENT_PROVIDER_MODE: 'fake',
            }),
          ],
        }),
        ProvidersModule.forRoot(),
      ],
    }).compile();

    const otpProvider = module.get(OTP_PROVIDER);
    const kycProvider = module.get(KYC_PROVIDER);
    const storageProvider = module.get(STORAGE_PROVIDER);
    const mapsProvider = module.get(MAPS_PROVIDER);
    const pushProvider = module.get(PUSH_PROVIDER);
    const emailProvider = module.get(EMAIL_PROVIDER);
    const paymentProvider = module.get(PAYMENT_PROVIDER);

    expect(otpProvider).toBeInstanceOf(FakeOtpProvider);
    expect(kycProvider).toBeInstanceOf(FakeKycProvider);
    expect(storageProvider).toBeDefined();
    expect(mapsProvider).toBeDefined();
    expect(pushProvider).toBeDefined();
    expect(emailProvider).toBeDefined();
    expect(paymentProvider).toBeDefined();
  });

  it('should record calls to fake providers', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ SMS_PROVIDER_MODE: 'fake' })],
        }),
        ProvidersModule.forRoot(),
      ],
    }).compile();

    const otpProvider = module.get(OTP_PROVIDER) as FakeOtpProvider;

    await otpProvider.sendSms('+2348012345678', '123456');

    const calls = otpProvider.getCalls('sendSms');
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe('+2348012345678');
    expect(calls[0].args[1]).toBe('123456');
  });

  it('should support scripted outcomes', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ KYC_PROVIDER_MODE: 'fake' })],
        }),
        ProvidersModule.forRoot(),
      ],
    }).compile();

    const kycProvider = module.get(KYC_PROVIDER) as FakeKycProvider;

    // Script a failure outcome
    kycProvider.scriptOutcomes('verifyBvn', [
      { success: false, verified: false, error: 'Invalid BVN' },
    ]);

    const result = await kycProvider.verifyBvn('12345678901', '+2348012345678');

    expect(result.success).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.error).toBe('Invalid BVN');
  });
});

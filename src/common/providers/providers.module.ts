/**
 * Providers module
 * Selects the fake or real implementation of every external provider from the
 * validated config (`providers.<name>`, set by `<NAME>_PROVIDER=fake|real`).
 */

import { DynamicModule, FactoryProvider, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import {
  OTP_PROVIDER,
  KYC_PROVIDER,
  STORAGE_PROVIDER,
  MAPS_PROVIDER,
  PUSH_PROVIDER,
  EMAIL_PROVIDER,
  PAYMENT_PROVIDER,
} from './index.js';
import { DojahKycProvider } from './dojah-kyc.provider.js';
import { S3StorageProvider, type S3Settings } from './s3-storage.provider.js';
import { SmtpEmailProvider, type SmtpSettings } from './smtp-email.provider.js';
import { FcmPushProvider, parseServiceAccount } from './fcm-push.provider.js';
import {
  FakeOtpProvider,
  FakeKycProvider,
  FakeStorageProvider,
  FakeMapsProvider,
  FakePushProvider,
  FakeEmailProvider,
  FakePaymentProvider,
} from './fakes/index.js';

function createS3Provider(config: ConfigService): S3StorageProvider {
  const settings = config.get<S3Settings>('aws');
  if (!settings?.bucket || !settings.region || !settings.accessKeyId || !settings.secretAccessKey) {
    throw new Error(
      'STORAGE_PROVIDER=real is set but AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not all set',
    );
  }
  return new S3StorageProvider(settings);
}

function createDojahProvider(config: ConfigService): DojahKycProvider {
  const settings = config.get<{ appId: string; secretKey: string; baseUrl: string }>('dojah');
  if (!settings?.appId || !settings.secretKey || !settings.baseUrl) {
    throw new Error('KYC_PROVIDER=real is set but DOJAH_APP_ID, DOJAH_SECRET_KEY and DOJAH_BASE_URL are not all set');
  }
  return new DojahKycProvider(settings);
}

function createSmtpProvider(config: ConfigService): SmtpEmailProvider {
  const settings = config.get<SmtpSettings>('smtp');
  if (!settings?.host || !settings.port || !settings.user || !settings.pass || !settings.from) {
    throw new Error('EMAIL_PROVIDER=real is set but SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM are not all set');
  }
  return new SmtpEmailProvider(settings);
}

function createFcmProvider(config: ConfigService): FcmPushProvider {
  const raw = config.get<string>('firebase.credentials');
  if (!raw) {
    throw new Error('PUSH_PROVIDER=real is set but FIREBASE_CREDENTIALS is not set');
  }
  try {
    return new FcmPushProvider(parseServiceAccount(raw));
  } catch (error) {
    throw new Error(`PUSH_PROVIDER=real is set but FIREBASE_CREDENTIALS is not usable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type ProviderName = keyof AppConfig['providers'];

/**
 * Build a provider factory. Reading the mode from `providers.<name>` (and
 * failing fast when "real" has no implementation yet) means a production
 * misconfiguration can never silently run on a fake.
 */
function providerFactory(
  token: symbol,
  name: ProviderName,
  createFake: () => unknown,
  describeReal: string,
  createReal?: (config: ConfigService) => unknown,
): FactoryProvider {
  return {
    provide: token,
    inject: [ConfigService],
    useFactory: (config: ConfigService) => {
      const mode = config.get<string>(`providers.${name}`) ?? 'fake';
      if (mode === 'fake') {
        return createFake();
      }
      if (createReal) {
        return createReal(config);
      }
      // The real adapter is added in its own task (see the Build Plan).
      throw new Error(
        `${name.toUpperCase()}_PROVIDER=real is set but the ${describeReal} adapter is not implemented yet`,
      );
    },
  };
}

@Module({})
export class ProvidersModule {
  static forRoot(): DynamicModule {
    return {
      module: ProvidersModule,
      global: true,
      providers: [
        providerFactory(OTP_PROVIDER, 'sms', () => new FakeOtpProvider(), 'SMS (Termii)'),
        providerFactory(KYC_PROVIDER, 'kyc', () => new FakeKycProvider(), 'Dojah', createDojahProvider),
        providerFactory(STORAGE_PROVIDER, 'storage', () => new FakeStorageProvider(), 'AWS S3', createS3Provider),
        providerFactory(MAPS_PROVIDER, 'maps', () => new FakeMapsProvider(), 'Google Maps'),
        providerFactory(PUSH_PROVIDER, 'push', () => new FakePushProvider(), 'Firebase FCM', createFcmProvider),
        providerFactory(EMAIL_PROVIDER, 'email', () => new FakeEmailProvider(), 'SMTP', createSmtpProvider),
        providerFactory(PAYMENT_PROVIDER, 'payments', () => new FakePaymentProvider(), 'Paystack'),
      ],
      exports: [
        OTP_PROVIDER,
        KYC_PROVIDER,
        STORAGE_PROVIDER,
        MAPS_PROVIDER,
        PUSH_PROVIDER,
        EMAIL_PROVIDER,
        PAYMENT_PROVIDER,
      ],
    };
  }
}

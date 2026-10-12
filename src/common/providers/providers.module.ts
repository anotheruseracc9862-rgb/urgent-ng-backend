/**
 * Providers module
 * Selects the fake or real implementation of every external provider from the
 * validated config (`providers.<name>`: stand-ins under NODE_ENV=test, the vendor otherwise).
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
  GOOGLE_IDENTITY_PROVIDER,
  FakeGoogleIdentityProvider,
} from './index.js';
import { GoogleMapsProvider } from './google-maps.provider.js';
import { TermiiOtpProvider } from './termii-otp.provider.js';
import { LogOtpProvider } from './log-otp.provider.js';
import { GoogleIdentityProvider } from './google-identity-real.provider.js';
import { ProviderError } from './provider.error.js';
import type { IGoogleIdentityProvider } from './google-identity.provider.js';
import { DojahKycProvider } from './dojah-kyc.provider.js';
import { S3StorageProvider, type S3Settings } from './s3-storage.provider.js';
import { SmtpEmailProvider, type SmtpSettings } from './smtp-email.provider.js';
import { FcmPushProvider, parseServiceAccount } from './fcm-push.provider.js';
import { PaystackPaymentProvider, type PaystackSettings } from './paystack-payment.provider.js';
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
      'Storage is not configured: AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must all be set',
    );
  }
  return new S3StorageProvider(settings);
}

function createDojahProvider(config: ConfigService): DojahKycProvider {
  const settings = config.get<{ appId: string; secretKey: string; baseUrl: string }>('dojah');
  if (!settings?.appId || !settings.secretKey || !settings.baseUrl) {
    throw new Error('KYC is not configured: DOJAH_APP_ID, DOJAH_SECRET_KEY and DOJAH_BASE_URL must all be set');
  }
  return new DojahKycProvider(settings);
}

/**
 * Google sign-in is optional. Without a client id the real provider is "not configured": it refuses
 * every call with a provider error, so the sign-in route answers 503 and the rest of the app boots.
 */
function createGoogleProvider(config: ConfigService): IGoogleIdentityProvider {
  const clientId = config.get<string>('google.clientId');
  if (!clientId) {
    return {
      verifyIdToken: () =>
        Promise.reject(new ProviderError('google', 'GOOGLE_CLIENT_ID is not set.', { retryable: false })),
    };
  }
  return new GoogleIdentityProvider({ clientId });
}

function createOtpProvider(config: ConfigService): TermiiOtpProvider | LogOtpProvider {
  const sms = config.get<{ apiKey: string; senderId: string; baseUrl: string; channel: string }>('sms');
  const smtp = config.get<SmtpSettings>('smtp');
  const email = smtp?.host && smtp.port && smtp.user && smtp.pass && smtp.from ? new SmtpEmailProvider(smtp) : null;
  if (!sms?.apiKey || !sms.senderId) {
    // No SMS vendor yet: fine while developing (the code is logged), never in production.
    if (config.get<string>('nodeEnv') === 'production') {
      throw new Error('SMS is not configured: SMS_API_KEY and SMS_SENDER_ID must both be set in production');
    }
    return new LogOtpProvider(email);
  }
  const channel = sms.channel === 'dnd' || sms.channel === 'whatsapp' ? sms.channel : 'generic';
  return new TermiiOtpProvider({ apiKey: sms.apiKey, senderId: sms.senderId, baseUrl: sms.baseUrl, channel }, email);
}

function createMapsProvider(config: ConfigService): GoogleMapsProvider {
  const apiKey = config.get<string>('maps.apiKey');
  if (!apiKey) {
    throw new Error('Maps is not configured: MAPS_API_KEY is not set');
  }
  return new GoogleMapsProvider({ apiKey });
}

function createPaystackProvider(config: ConfigService): PaystackPaymentProvider {
  const settings = config.get<PaystackSettings>('paystack');
  if (!settings?.secretKey) {
    throw new Error('Payments are not configured: PAYSTACK_SECRET_KEY is not set');
  }
  return new PaystackPaymentProvider(settings);
}

function createSmtpProvider(config: ConfigService): SmtpEmailProvider {
  const settings = config.get<SmtpSettings>('smtp');
  if (!settings?.host || !settings.port || !settings.user || !settings.pass || !settings.from) {
    throw new Error('Email is not configured: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM must all be set');
  }
  return new SmtpEmailProvider(settings);
}

function createFcmProvider(config: ConfigService): FcmPushProvider {
  const raw = config.get<string>('firebase.credentials');
  if (!raw) {
    throw new Error('Push is not configured: FIREBASE_CREDENTIALS is not set');
  }
  try {
    return new FcmPushProvider(parseServiceAccount(raw));
  } catch (error) {
    throw new Error(`Push is not configured: FIREBASE_CREDENTIALS is not usable: ${error instanceof Error ? error.message : String(error)}`);
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
        `${name} needs the ${describeReal} adapter, which is not implemented yet`,
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
        providerFactory(OTP_PROVIDER, 'sms', () => new FakeOtpProvider(), 'SMS (Termii)', createOtpProvider),
        providerFactory(KYC_PROVIDER, 'kyc', () => new FakeKycProvider(), 'Dojah', createDojahProvider),
        providerFactory(STORAGE_PROVIDER, 'storage', () => new FakeStorageProvider(), 'AWS S3', createS3Provider),
        providerFactory(MAPS_PROVIDER, 'maps', () => new FakeMapsProvider(), 'Google Maps', createMapsProvider),
        providerFactory(PUSH_PROVIDER, 'push', () => new FakePushProvider(), 'Firebase FCM', createFcmProvider),
        providerFactory(EMAIL_PROVIDER, 'email', () => new FakeEmailProvider(), 'SMTP', createSmtpProvider),
        providerFactory(PAYMENT_PROVIDER, 'payments', () => new FakePaymentProvider(), 'Paystack', createPaystackProvider),
        providerFactory(GOOGLE_IDENTITY_PROVIDER, 'google', () => new FakeGoogleIdentityProvider(), 'Google', createGoogleProvider),
      ],
      exports: [
        OTP_PROVIDER,
        KYC_PROVIDER,
        STORAGE_PROVIDER,
        MAPS_PROVIDER,
        PUSH_PROVIDER,
        EMAIL_PROVIDER,
        PAYMENT_PROVIDER,
        GOOGLE_IDENTITY_PROVIDER,
      ],
    };
  }
}

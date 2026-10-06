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
import {
  FakeOtpProvider,
  FakeKycProvider,
  FakeStorageProvider,
  FakeMapsProvider,
  FakePushProvider,
  FakeEmailProvider,
  FakePaymentProvider,
} from './fakes/index.js';

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
): FactoryProvider {
  return {
    provide: token,
    inject: [ConfigService],
    useFactory: (config: ConfigService) => {
      const mode = config.get<string>(`providers.${name}`) ?? 'fake';
      if (mode === 'fake') {
        return createFake();
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
        providerFactory(KYC_PROVIDER, 'kyc', () => new FakeKycProvider(), 'Dojah'),
        providerFactory(STORAGE_PROVIDER, 'storage', () => new FakeStorageProvider(), 'AWS S3'),
        providerFactory(MAPS_PROVIDER, 'maps', () => new FakeMapsProvider(), 'Google Maps'),
        providerFactory(PUSH_PROVIDER, 'push', () => new FakePushProvider(), 'Firebase FCM'),
        providerFactory(EMAIL_PROVIDER, 'email', () => new FakeEmailProvider(), 'Mailgun'),
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

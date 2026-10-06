/**
 * Providers module
 * Dynamically selects fake or real provider implementations based on config
 */

import { Module, DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

@Module({})
export class ProvidersModule {
  static forRoot(): DynamicModule {
    return {
      module: ProvidersModule,
      providers: [
        // OTP Provider
        {
          provide: OTP_PROVIDER,
          useFactory: (configService: ConfigService) => {
            const mode = configService.get<string>('SMS_PROVIDER_MODE', 'fake');
            if (mode === 'fake') {
              return new FakeOtpProvider();
            }
            // TODO: Return real implementation when available
            throw new Error(`OTP provider mode "${mode}" not implemented yet`);
          },
          inject: [ConfigService],
        },

        // KYC Provider
        {
          provide: KYC_PROVIDER,
          useFactory: (configService: ConfigService) => {
            const mode = configService.get<string>('KYC_PROVIDER_MODE', 'fake');
            if (mode === 'fake') {
              return new FakeKycProvider();
            }
            // TODO: Return real Dojah implementation when available
            throw new Error(`KYC provider mode "${mode}" not implemented yet`);
          },
          inject: [ConfigService],
        },

        // Storage Provider
        {
          provide: STORAGE_PROVIDER,
          useFactory: (configService: ConfigService) => {
            const mode = configService.get<string>('STORAGE_PROVIDER_MODE', 'fake');
            if (mode === 'fake') {
              return new FakeStorageProvider();
            }
            // TODO: Return real AWS S3 implementation when available
            throw new Error(`Storage provider mode "${mode}" not implemented yet`);
          },
          inject: [ConfigService],
        },

        // Maps Provider
        {
          provide: MAPS_PROVIDER,
          useFactory: (configService: ConfigService) => {
            const mode = configService.get<string>('MAPS_PROVIDER_MODE', 'fake');
            if (mode === 'fake') {
              return new FakeMapsProvider();
            }
            // TODO: Return real Google Maps implementation when available
            throw new Error(`Maps provider mode "${mode}" not implemented yet`);
          },
          inject: [ConfigService],
        },

        // Push Provider
        {
          provide: PUSH_PROVIDER,
          useFactory: (configService: ConfigService) => {
            const mode = configService.get<string>('PUSH_PROVIDER_MODE', 'fake');
            if (mode === 'fake') {
              return new FakePushProvider();
            }
            // TODO: Return real FCM implementation when available
            throw new Error(`Push provider mode "${mode}" not implemented yet`);
          },
          inject: [ConfigService],
        },

        // Email Provider
        {
          provide: EMAIL_PROVIDER,
          useFactory: (configService: ConfigService) => {
            const mode = configService.get<string>('EMAIL_PROVIDER_MODE', 'fake');
            if (mode === 'fake') {
              return new FakeEmailProvider();
            }
            // TODO: Return real Mailgun implementation when available
            throw new Error(`Email provider mode "${mode}" not implemented yet`);
          },
          inject: [ConfigService],
        },

        // Payment Provider
        {
          provide: PAYMENT_PROVIDER,
          useFactory: (configService: ConfigService) => {
            const mode = configService.get<string>('PAYMENT_PROVIDER_MODE', 'fake');
            if (mode === 'fake') {
              return new FakePaymentProvider();
            }
            // TODO: Return real Paystack implementation when available
            throw new Error(`Payment provider mode "${mode}" not implemented yet`);
          },
          inject: [ConfigService],
        },
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
      global: true,
    };
  }
}

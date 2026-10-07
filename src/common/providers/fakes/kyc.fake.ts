/**
 * Fake KYC provider.
 *
 * Deterministic by the last four digits of the NIN (Backend PRD section 10.3):
 *   0000 -> selfie mismatch      1111 -> NIN not found
 *   8888 -> provider timeout     9999 -> provider error
 *   anything else -> verified with confidence 99
 * Scripted outcomes (see BaseFake) override these rules.
 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BaseFake } from './base.fake.js';
import {
  IKycProvider,
  KycVerifyRequest,
  KycVerifyResult,
} from '../kyc.provider.js';

@Injectable()
export class FakeKycProvider extends BaseFake implements IKycProvider {
  async verifyNinWithSelfie(
    request: KycVerifyRequest,
  ): Promise<KycVerifyResult> {
    // Never record the NIN or the selfie in the call log.
    this.recordCall('verifyNinWithSelfie', {
      ninLast4: request.nin.slice(-4),
      threshold: request.threshold,
    });

    if (this.hasScriptedOutcome('verifyNinWithSelfie')) {
      return this.getNextOutcome<KycVerifyResult>('verifyNinWithSelfie')!;
    }

    const providerRequestId = `fake-kyc-${randomUUID()}`;
    const maskedAttributes = { ninLast4: request.nin.slice(-4) };

    switch (request.nin.slice(-4)) {
      case '0000':
        return {
          outcome: 'FAILED',
          failureReason: 'SELFIE_MISMATCH',
          confidence: 41,
          countsAgainstAllowance: true,
          providerRequestId,
          maskedAttributes,
        };
      case '1111':
        return {
          outcome: 'FAILED',
          failureReason: 'IDENTITY_MISMATCH',
          countsAgainstAllowance: true,
          providerRequestId,
          maskedAttributes,
        };
      case '8888':
        return {
          outcome: 'FAILED',
          failureReason: 'PROVIDER_TIMEOUT',
          countsAgainstAllowance: false,
          providerRequestId,
        };
      case '9999':
        return {
          outcome: 'FAILED',
          failureReason: 'PROVIDER_ERROR',
          countsAgainstAllowance: false,
          providerRequestId,
        };
      default:
        return {
          outcome: 'VERIFIED',
          confidence: 99,
          countsAgainstAllowance: true,
          providerRequestId,
          maskedAttributes,
        };
    }
  }
}

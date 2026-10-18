/**
 * Fake KYC provider.
 *
 * Deterministic by the last four digits of the NIN or BVN (Backend PRD section 10.3):
 *   0000 -> selfie mismatch      1111 -> number not found
 *   8888 -> provider timeout     9999 -> provider error
 *   2222 -> verified, but the registry holds another person's name
 *   3333 -> verified, but the registry holds another date of birth
 *   4444 -> verified, but the registry record is unreadable
 *   anything else -> verified with confidence 99 and the FAKE_REGISTRY_IDENTITY record
 * Scripted outcomes (see BaseFake) override these rules.
 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BaseFake } from './base.fake.js';
import {
  IKycProvider,
  KycBvnVerifyRequest,
  KycRegistryIdentity,
  KycVerifyRequest,
  KycVerifyResult,
} from '../kyc.provider.js';

/** The person every fake number belongs to, unless the last four digits say otherwise. */
export const FAKE_REGISTRY_IDENTITY: KycRegistryIdentity = {
  firstName: 'ADA',
  middleName: 'CHINWE',
  lastName: 'OKAFOR',
  dateOfBirth: '1994-03-21',
};

@Injectable()
export class FakeKycProvider extends BaseFake implements IKycProvider {
  async verifyNinWithSelfie(request: KycVerifyRequest): Promise<KycVerifyResult> {
    // Never record the NIN or the selfie in the call log.
    this.recordCall('verifyNinWithSelfie', { ninLast4: request.nin.slice(-4), threshold: request.threshold });

    if (this.hasScriptedOutcome('verifyNinWithSelfie')) {
      return this.getNextOutcome<KycVerifyResult>('verifyNinWithSelfie')!;
    }
    return this.answer(request.nin, 'ninLast4');
  }

  async verifyBvnWithSelfie(request: KycBvnVerifyRequest): Promise<KycVerifyResult> {
    this.recordCall('verifyBvnWithSelfie', { bvnLast4: request.bvn.slice(-4), threshold: request.threshold });

    if (this.hasScriptedOutcome('verifyBvnWithSelfie')) {
      return this.getNextOutcome<KycVerifyResult>('verifyBvnWithSelfie')!;
    }
    return this.answer(request.bvn, 'bvnLast4');
  }

  private answer(idNumber: string, maskKey: 'ninLast4' | 'bvnLast4'): KycVerifyResult {
    const providerRequestId = `fake-kyc-${randomUUID()}`;
    const maskedAttributes = { [maskKey]: idNumber.slice(-4) };
    const verified = (identity?: KycRegistryIdentity): KycVerifyResult => ({
      outcome: 'VERIFIED',
      confidence: 99,
      countsAgainstAllowance: true,
      providerRequestId,
      maskedAttributes,
      ...(identity ? { identity } : {}),
    });

    switch (idNumber.slice(-4)) {
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
        return { outcome: 'FAILED', failureReason: 'PROVIDER_TIMEOUT', countsAgainstAllowance: false, providerRequestId };
      case '9999':
        return { outcome: 'FAILED', failureReason: 'PROVIDER_ERROR', countsAgainstAllowance: false, providerRequestId };
      case '2222':
        return verified({ ...FAKE_REGISTRY_IDENTITY, firstName: 'MUSA', middleName: undefined, lastName: 'IBRAHIM' });
      case '3333':
        return verified({ ...FAKE_REGISTRY_IDENTITY, dateOfBirth: '1990-01-05' });
      case '4444':
        return verified();
      default:
        return verified(FAKE_REGISTRY_IDENTITY);
    }
  }
}

/**
 * Fake KYC provider for testing
 */

import { Injectable } from '@nestjs/common';
import { BaseFake } from './base.fake.js';
import { IKycProvider, KycVerificationResult } from '../kyc.provider.js';

@Injectable()
export class FakeKycProvider extends BaseFake implements IKycProvider {
  async verifyBvn(bvn: string, phoneNumber: string): Promise<KycVerificationResult> {
    this.recordCall('verifyBvn', bvn, phoneNumber);

    if (this.hasScriptedOutcome('verifyBvn')) {
      return this.getNextOutcome<KycVerificationResult>('verifyBvn')!;
    }

    // Default success response
    return {
      success: true,
      verified: true,
      referenceId: `fake-bvn-${Date.now()}`,
      firstName: 'John',
      lastName: 'Doe',
      dateOfBirth: '1990-01-01',
    };
  }

  async verifyNin(nin: string): Promise<KycVerificationResult> {
    this.recordCall('verifyNin', nin);

    if (this.hasScriptedOutcome('verifyNin')) {
      return this.getNextOutcome<KycVerificationResult>('verifyNin')!;
    }

    // Default success response
    return {
      success: true,
      verified: true,
      referenceId: `fake-nin-${Date.now()}`,
      firstName: 'Jane',
      lastName: 'Smith',
      dateOfBirth: '1985-06-15',
    };
  }

  async getVerificationStatus(referenceId: string): Promise<KycVerificationResult> {
    this.recordCall('getVerificationStatus', referenceId);

    if (this.hasScriptedOutcome('getVerificationStatus')) {
      return this.getNextOutcome<KycVerificationResult>('getVerificationStatus')!;
    }

    // Default success response
    return {
      success: true,
      verified: true,
      referenceId,
    };
  }
}

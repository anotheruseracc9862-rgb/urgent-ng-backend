/**
 * KYC verification provider interface
 */

export interface KycVerificationResult {
  success: boolean;
  verified: boolean;
  referenceId?: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface IKycProvider {
  /**
   * Verify BVN (Bank Verification Number)
   */
  verifyBvn(bvn: string, phoneNumber: string): Promise<KycVerificationResult>;

  /**
   * Verify NIN (National Identity Number)
   */
  verifyNin(nin: string): Promise<KycVerificationResult>;

  /**
   * Get verification status by reference ID
   */
  getVerificationStatus(referenceId: string): Promise<KycVerificationResult>;
}

export const KYC_PROVIDER = Symbol('KYC_PROVIDER');

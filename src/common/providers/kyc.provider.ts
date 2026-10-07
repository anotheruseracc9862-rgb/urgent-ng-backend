/**
 * KYC verification provider interface (Backend PRD section 10.3).
 *
 * Verification is NIN plus selfie only. The call is synchronous and returns a
 * normalised result; the Dojah adapter maps the vendor response to this shape
 * and the fake mirrors it.
 */

export type KycFailureReason =
  | 'SELFIE_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'DOCUMENT_INVALID'
  | 'INSUFFICIENT_DATA'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_TIMEOUT'
  /** Set by the verification service when the identity is already verified on another account. */
  | 'DUPLICATE_IDENTITY';

export interface KycVerifyRequest {
  /** The NIN. Transit-only: never persist, log or return it. */
  nin: string;
  /** Selfie as base64, without the `data:image/...;base64,` prefix. */
  selfieImageBase64: string;
  /** Selfie match threshold, 50 to 100. Defaults to the configured value. */
  threshold?: number;
  /** Give up after this many milliseconds and report PROVIDER_TIMEOUT. */
  timeoutMs?: number;
}

export interface KycVerifyResult {
  outcome: 'VERIFIED' | 'FAILED';
  failureReason?: KycFailureReason;
  /** Selfie match confidence, 0 to 100, when the provider returned one. */
  confidence?: number;
  /** False for provider-caused failures: the runner keeps the attempt. */
  countsAgainstAllowance: boolean;
  providerRequestId?: string;
  /** Masked attributes only, for example the last four digits of the NIN. */
  maskedAttributes?: Record<string, string>;
}

export interface IKycProvider {
  verifyNinWithSelfie(request: KycVerifyRequest): Promise<KycVerifyResult>;
}

export const KYC_PROVIDER = Symbol('KYC_PROVIDER');

/**
 * KYC verification provider interface (Backend PRD section 10.3).
 *
 * Verification is a NIN or a BVN, plus a selfie. The call is synchronous and returns a
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

/**
 * Which part of a FAILED result went wrong, when the reason alone is too broad. Safe to show the
 * runner: it says what to re-check, never what the registry holds.
 */
export const KYC_FAILURE_DETAILS = ['ID_NOT_FOUND', 'ID_INVALID', 'SELFIE_UNUSABLE', 'NAME_MISMATCH', 'DOB_MISMATCH', 'NAME_AND_DOB_MISMATCH'] as const;
export type KycFailureDetail = (typeof KYC_FAILURE_DETAILS)[number];

export type KycIdType = 'NIN' | 'BVN';

interface KycVerifyBase {
  /** Selfie as base64, without the `data:image/...;base64,` prefix. */
  selfieImageBase64: string;
  /** Selfie match threshold, 50 to 100. Defaults to the configured value. */
  threshold?: number;
  /** Give up after this many milliseconds and report PROVIDER_TIMEOUT. */
  timeoutMs?: number;
}

export interface KycVerifyRequest extends KycVerifyBase {
  /** The NIN. Transit-only: never persist, log or return it. */
  nin: string;
}

export interface KycBvnVerifyRequest extends KycVerifyBase {
  /** The BVN. Transit-only: never persist, log or return it. */
  bvn: string;
}

/**
 * Who the registry says the person is. Personal data: the verification service compares it with
 * what the runner typed and then drops it. Never persist, log or return it.
 */
export interface KycRegistryIdentity {
  firstName: string;
  lastName: string;
  middleName?: string;
  /** YYYY-MM-DD. */
  dateOfBirth: string;
}

export interface KycVerifyResult {
  outcome: 'VERIFIED' | 'FAILED';
  failureReason?: KycFailureReason;
  failureDetail?: KycFailureDetail;
  /** Selfie match confidence, 0 to 100, when the provider returned one. */
  confidence?: number;
  /** False for provider-caused failures: the runner keeps the attempt. */
  countsAgainstAllowance: boolean;
  providerRequestId?: string;
  /** Masked attributes only, for example the last four digits of the NIN. */
  maskedAttributes?: Record<string, string>;
  /** The registry record, on VERIFIED only and only when the provider returned a readable one. */
  identity?: KycRegistryIdentity;
}

export interface IKycProvider {
  verifyNinWithSelfie(request: KycVerifyRequest): Promise<KycVerifyResult>;
  verifyBvnWithSelfie(request: KycBvnVerifyRequest): Promise<KycVerifyResult>;
}

export const KYC_PROVIDER = Symbol('KYC_PROVIDER');

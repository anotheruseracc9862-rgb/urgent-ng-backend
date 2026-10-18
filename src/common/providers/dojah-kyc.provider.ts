import { Injectable, Logger } from '@nestjs/common';
import { readRegistryIdentity } from './dojah-identity.js';
import type {
  IKycProvider,
  KycBvnVerifyRequest,
  KycFailureReason,
  KycIdType,
  KycVerifyRequest,
  KycVerifyResult,
} from './kyc.provider.js';

export interface DojahSettings {
  appId: string;
  secretKey: string;
  baseUrl: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Waits between retries of a 429 answer. Three tries in total. */
const DEFAULT_RETRY_DELAYS_MS = [500, 1500];

interface DojahSuccessBody {
  entity?: Record<string, unknown> & { selfie_verification?: { match?: boolean; confidence_value?: number } };
}

interface Lookup {
  idType: KycIdType;
  idNumber: string;
  selfieImageBase64: string;
  threshold?: number;
  timeoutMs?: number;
}

const ENDPOINT: Record<KycIdType, { path: string; field: string; maskKey: string }> = {
  NIN: { path: '/api/v1/kyc/nin/verify', field: 'nin', maskKey: 'ninLast4' },
  BVN: { path: '/api/v1/kyc/bvn/verify', field: 'bvn', maskKey: 'bvnLast4' },
};

/**
 * Real KYC provider: Dojah NIN or BVN with selfie (Backend PRD 10.3).
 *
 *   POST {baseUrl}/api/v1/kyc/nin/verify   or   /api/v1/kyc/bvn/verify
 *   Authorization: <secret key, sent as is, no "Bearer">    AppId: <app id>
 *   { nin | bvn, selfie_image (base64, no data: prefix), threshold }
 *
 * The id number and the selfie exist only in memory here: they are never logged and never put in
 * a returned value. On a selfie match the registry name and date of birth are returned in
 * `identity` so the verification service can compare them with what the runner typed. Everything
 * else Dojah returns is discarded.
 */
@Injectable()
export class DojahKycProvider implements IKycProvider {
  private readonly logger = new Logger(DojahKycProvider.name);

  constructor(
    private readonly settings: DojahSettings,
    private readonly options: {
      fetchImpl?: typeof fetch;
      retryDelaysMs?: number[];
    } = {},
  ) {}

  verifyNinWithSelfie(request: KycVerifyRequest): Promise<KycVerifyResult> {
    const { nin, ...rest } = request;
    return this.verify({ idType: 'NIN', idNumber: nin, ...rest });
  }

  verifyBvnWithSelfie(request: KycBvnVerifyRequest): Promise<KycVerifyResult> {
    const { bvn, ...rest } = request;
    return this.verify({ idType: 'BVN', idNumber: bvn, ...rest });
  }

  private async verify(lookup: Lookup): Promise<KycVerifyResult> {
    const maskedAttributes = { [ENDPOINT[lookup.idType].maskKey]: lookup.idNumber.slice(-4) };
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.call(lookup);
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          return this.failed('PROVIDER_TIMEOUT', false);
        }
        return this.failed('PROVIDER_ERROR', false);
      }

      if (response.status === 429 && attempt < delays.length) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        continue;
      }
      return this.map(response, maskedAttributes);
    }
  }

  private call(lookup: Lookup): Promise<Response> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const endpoint = ENDPOINT[lookup.idType];
    return doFetch(`${this.settings.baseUrl.replace(/\/+$/, '')}${endpoint.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.settings.secretKey,
        AppId: this.settings.appId,
      },
      body: JSON.stringify({
        [endpoint.field]: lookup.idNumber,
        selfie_image: lookup.selfieImageBase64,
        threshold: lookup.threshold,
      }),
      signal: AbortSignal.timeout(lookup.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  }

  private async map(response: Response, maskedAttributes: Record<string, string>): Promise<KycVerifyResult> {
    const providerRequestId = response.headers.get('x-request-id') ?? undefined;
    const base = { providerRequestId, maskedAttributes };

    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as DojahSuccessBody;
      const selfie = body.entity?.selfie_verification;
      if (selfie?.match === undefined) {
        this.logger.error('Dojah answered 200 without a selfie match result');
        return this.failed('PROVIDER_ERROR', false);
      }
      const confidence = typeof selfie.confidence_value === 'number' ? selfie.confidence_value : undefined;
      if (!selfie.match) {
        return { outcome: 'FAILED', failureReason: 'SELFIE_MISMATCH', confidence, countsAgainstAllowance: true, ...base };
      }
      const identity = readRegistryIdentity(body.entity);
      if (!identity) {
        // Logged without the values. The service refuses to verify without a record to compare.
        this.logger.warn('Dojah matched the selfie but returned no readable name and date of birth');
      }
      return { outcome: 'VERIFIED', confidence, countsAgainstAllowance: true, ...(identity ? { identity } : {}), ...base };
    }

    switch (response.status) {
      case 404:
        return { outcome: 'FAILED', failureReason: 'IDENTITY_MISMATCH', countsAgainstAllowance: true, ...base };
      case 400: {
        const message = await this.errorText(response);
        const reason: KycFailureReason = /image|selfie|photo|base64/i.test(message)
          ? 'INSUFFICIENT_DATA'
          : 'DOCUMENT_INVALID';
        return { outcome: 'FAILED', failureReason: reason, countsAgainstAllowance: true, ...base };
      }
      case 401:
      case 402:
        // Our credentials or wallet, not the runner's fault. Operations must act.
        this.logger.error(`ALERT: Dojah refused our request (HTTP ${response.status}). Check DOJAH_SECRET_KEY, DOJAH_APP_ID and the wallet balance.`);
        return this.failed('PROVIDER_ERROR', false, providerRequestId);
      default:
        this.logger.error(`Dojah answered HTTP ${response.status}`);
        return this.failed('PROVIDER_ERROR', false, providerRequestId);
    }
  }

  private async errorText(response: Response): Promise<string> {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
    return `${typeof body.error === 'string' ? body.error : ''} ${typeof body.message === 'string' ? body.message : ''}`;
  }

  private failed(reason: KycFailureReason, countsAgainstAllowance: boolean, providerRequestId?: string): KycVerifyResult {
    return { outcome: 'FAILED', failureReason: reason, countsAgainstAllowance, providerRequestId };
  }
}

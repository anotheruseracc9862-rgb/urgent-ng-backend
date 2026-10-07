import { Injectable, Logger } from '@nestjs/common';
import type {
  IKycProvider,
  KycFailureReason,
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
  entity?: { selfie_verification?: { match?: boolean; confidence_value?: number } };
}

/**
 * Real KYC provider: Dojah NIN with selfie (Backend PRD 10.3).
 *
 *   POST {baseUrl}/api/v1/kyc/nin/verify
 *   Authorization: <secret key, sent as is, no "Bearer">    AppId: <app id>
 *   { nin, selfie_image (base64, no data: prefix), threshold }
 *
 * The NIN and the selfie exist only in memory here: they are never logged and never put in
 * a returned value. Everything Dojah returns except the match result is discarded.
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

  async verifyNinWithSelfie(request: KycVerifyRequest): Promise<KycVerifyResult> {
    const maskedAttributes = { ninLast4: request.nin.slice(-4) };
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.call(request);
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

  private call(request: KycVerifyRequest): Promise<Response> {
    const doFetch = this.options.fetchImpl ?? fetch;
    return doFetch(`${this.settings.baseUrl.replace(/\/+$/, '')}/api/v1/kyc/nin/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.settings.secretKey,
        AppId: this.settings.appId,
      },
      body: JSON.stringify({
        nin: request.nin,
        selfie_image: request.selfieImageBase64,
        threshold: request.threshold,
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
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
      return selfie.match
        ? { outcome: 'VERIFIED', confidence, countsAgainstAllowance: true, ...base }
        : { outcome: 'FAILED', failureReason: 'SELFIE_MISMATCH', confidence, countsAgainstAllowance: true, ...base };
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

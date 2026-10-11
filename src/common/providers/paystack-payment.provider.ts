import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from './provider.error.js';
import type {
  ChargeAuthorizationInput,
  InitializeTransactionInput,
  InitializeTransactionResult,
  IPaymentProvider,
  RefundInput,
  RefundResult,
  TransactionStatus,
  VerifyTransactionResult,
} from './payment.provider.js';

export interface PaystackSettings {
  secretKey: string;
  /** The key a webhook is signed with. Paystack signs with the secret key; set this only if yours differs. */
  webhookSecret?: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.paystack.co';
const TIMEOUT_MS = 20_000;

interface PaystackEnvelope<T> {
  status: boolean;
  message?: string;
  data?: T;
}

interface TransactionData {
  status?: string;
  reference?: string;
  amount?: number;
  paid_at?: string | null;
  customer?: { email?: string };
  authorization?: { authorization_code?: string; reusable?: boolean };
}

/**
 * Real payment gateway: Paystack (Backend PRD 4.2, 22.2). Used only for Urgent.ng's own
 * products. Amounts are integer kobo on both sides.
 *
 * - `verifyTransaction` is the only trusted source of a payment's status.
 * - A transport failure, a timeout or a 5xx is a `ProviderError`; a declined card, an
 *   abandoned checkout or a failed transaction is a normal result.
 * - Nothing about a card is stored or returned except the reusable authorisation code.
 */
@Injectable()
export class PaystackPaymentProvider implements IPaymentProvider {
  private readonly logger = new Logger(PaystackPaymentProvider.name);

  constructor(
    private readonly settings: PaystackSettings,
    private readonly options: { fetchImpl?: typeof fetch } = {},
  ) {}

  async initializeTransaction(input: InitializeTransactionInput): Promise<InitializeTransactionResult> {
    const data = await this.request<{ authorization_url: string; access_code: string; reference: string }>('POST', '/transaction/initialize', {
      email: input.email,
      amount: input.amountKobo,
      reference: input.reference,
      currency: 'NGN',
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    });
    if (!data?.authorization_url || !data.access_code) {
      throw new ProviderError('paystack', 'Paystack answered without a checkout link.');
    }
    return { authorizationUrl: data.authorization_url, accessCode: data.access_code, reference: data.reference ?? input.reference };
  }

  async verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
    const data = await this.request<TransactionData>('GET', `/transaction/verify/${encodeURIComponent(reference)}`, undefined, {
      // An unknown reference is a normal "nothing was paid" answer, not a fault.
      notFoundIsAbandoned: true,
    });
    return this.toResult(data, reference);
  }

  async chargeAuthorization(input: ChargeAuthorizationInput): Promise<VerifyTransactionResult> {
    const data = await this.request<TransactionData>('POST', '/transaction/charge_authorization', {
      email: input.email,
      amount: input.amountKobo,
      authorization_code: input.authorizationCode,
      reference: input.reference,
      currency: 'NGN',
    });
    return this.toResult(data, input.reference);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const data = await this.request<{ id?: number | string; status?: string; transaction?: { reference?: string } }>('POST', '/refund', {
      transaction: input.reference,
      amount: input.amountKobo,
    });
    const status = String(data?.status ?? '').toLowerCase();
    return {
      providerRefundRef: data?.id !== undefined ? String(data.id) : `paystack-refund-${input.reference}`,
      status: status === 'processed' ? 'processed' : status === 'failed' || status === 'needs-attention' ? 'failed' : 'pending',
    };
  }

  /** HMAC-SHA512 of the raw body with the secret, compared in constant time (Paystack `x-paystack-signature`). */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
    if (!signature) return false;
    const secret = this.settings.webhookSecret || this.settings.secretKey;
    const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
    const given = Buffer.from(signature.toLowerCase());
    const wanted = Buffer.from(expected);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  // ---- internals ----

  private toResult(data: TransactionData | undefined, reference: string): VerifyTransactionResult {
    if (!data) {
      return { status: 'abandoned', reference, amountKobo: 0 };
    }
    const status = this.mapStatus(data.status);
    return {
      status,
      reference: data.reference ?? reference,
      amountKobo: Number(data.amount ?? 0),
      paidAt: data.paid_at ? new Date(data.paid_at) : undefined,
      authorizationCode: data.authorization?.reusable === false ? undefined : data.authorization?.authorization_code,
      customerEmail: data.customer?.email,
    };
  }

  private mapStatus(status: string | undefined): TransactionStatus {
    switch ((status ?? '').toLowerCase()) {
      case 'success':
        return 'success';
      case 'failed':
      case 'reversed':
        return 'failed';
      case 'abandoned':
        return 'abandoned';
      default:
        // ongoing, pending, processing, queued
        return 'pending';
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    options: { notFoundIsAbandoned?: boolean } = {},
  ): Promise<T | undefined> {
    const doFetch = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.settings.baseUrl ?? DEFAULT_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.settings.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProviderError('paystack', 'Could not reach Paystack.', { retryable: true, cause: error });
    }

    if (response.status === 404 && options.notFoundIsAbandoned) {
      return undefined;
    }
    if (response.status >= 500 || response.status === 429) {
      throw new ProviderError('paystack', `Paystack answered HTTP ${response.status}.`, { retryable: true });
    }
    let json: PaystackEnvelope<T>;
    try {
      json = (await response.json()) as PaystackEnvelope<T>;
    } catch (error) {
      throw new ProviderError('paystack', 'Paystack answered with something that is not JSON.', { cause: error });
    }
    if (response.status === 401 || response.status === 403) {
      this.logger.error('ALERT: Paystack refused our key. Check PAYSTACK_SECRET_KEY.');
      throw new ProviderError('paystack', 'Paystack refused the request.');
    }
    if (!response.ok || json.status === false) {
      // A business failure (a bad reference, a duplicate): not a transport fault, but not usable.
      throw new ProviderError('paystack', json.message ?? `Paystack answered HTTP ${response.status}.`);
    }
    return json.data;
  }
}

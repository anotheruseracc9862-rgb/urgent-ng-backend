/**
 * Payment gateway interface (Paystack), used only for Urgent.ng's own
 * products: Runner Pro, boosts and the optional verification fee (Backend PRD
 * section 22). Never used for the errand payment.
 *
 * Amounts are integer kobo. Transport failures throw `ProviderError`;
 * business outcomes (a declined card, an abandoned checkout) are returned.
 */

export interface InitializeTransactionInput {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface InitializeTransactionResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export type TransactionStatus = 'success' | 'failed' | 'abandoned' | 'pending';

export interface VerifyTransactionResult {
  status: TransactionStatus;
  reference: string;
  amountKobo: number;
  paidAt?: Date;
  /** Reusable card authorisation, returned on a successful card payment. */
  authorizationCode?: string;
  customerEmail?: string;
}

export interface ChargeAuthorizationInput {
  email: string;
  authorizationCode: string;
  amountKobo: number;
  reference: string;
}

export interface RefundInput {
  /** Reference of the original transaction. */
  reference: string;
  /** Omit to refund the full amount. */
  amountKobo?: number;
}

export interface RefundResult {
  providerRefundRef: string;
  status: 'pending' | 'processed' | 'failed';
}

export interface IPaymentProvider {
  initializeTransaction(
    input: InitializeTransactionInput,
  ): Promise<InitializeTransactionResult>;

  /** The only trusted source of payment status; never trust a browser redirect. */
  verifyTransaction(reference: string): Promise<VerifyTransactionResult>;

  /** Charge a saved authorisation, used for Runner Pro auto-renewal. */
  chargeAuthorization(
    input: ChargeAuthorizationInput,
  ): Promise<VerifyTransactionResult>;

  refund(input: RefundInput): Promise<RefundResult>;

  /** Verify a webhook against the raw request body, in constant time. */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

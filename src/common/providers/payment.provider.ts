/**
 * Payment gateway provider interface (Paystack)
 */

export interface PaymentInitializationResult {
  success: boolean;
  authorizationUrl?: string;
  accessCode?: string;
  reference?: string;
  error?: string;
}

export interface PaymentVerificationResult {
  success: boolean;
  status?: 'success' | 'failed' | 'pending';
  amount?: number; // In kobo
  reference?: string;
  paidAt?: Date;
  error?: string;
}

export interface RefundResult {
  success: boolean;
  refundId?: string;
  error?: string;
}

export interface IPaymentProvider {
  /**
   * Initialize a payment transaction
   */
  initializePayment(
    email: string,
    amountKobo: number,
    reference: string,
    callbackUrl?: string,
  ): Promise<PaymentInitializationResult>;

  /**
   * Verify a payment by reference
   */
  verifyPayment(reference: string): Promise<PaymentVerificationResult>;

  /**
   * Refund a payment
   */
  refundPayment(reference: string, amountKobo?: number): Promise<RefundResult>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

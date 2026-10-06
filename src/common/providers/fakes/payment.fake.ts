/**
 * Fake payment provider for testing
 */

import { Injectable } from '@nestjs/common';
import { BaseFake } from './base.fake.js';
import {
  IPaymentProvider,
  PaymentInitializationResult,
  PaymentVerificationResult,
  RefundResult,
} from '../payment.provider.js';

@Injectable()
export class FakePaymentProvider extends BaseFake implements IPaymentProvider {
  private payments = new Map<string, { amountKobo: number; status: 'success' | 'failed' | 'pending' }>();

  async initializePayment(
    email: string,
    amountKobo: number,
    reference: string,
    callbackUrl?: string,
  ): Promise<PaymentInitializationResult> {
    this.recordCall('initializePayment', email, amountKobo, reference, callbackUrl);

    if (this.hasScriptedOutcome('initializePayment')) {
      return this.getNextOutcome<PaymentInitializationResult>('initializePayment')!;
    }

    // Store payment as pending
    this.payments.set(reference, { amountKobo, status: 'pending' });

    return {
      success: true,
      authorizationUrl: `https://fake-paystack.com/pay/${reference}`,
      accessCode: `fake-access-${Date.now()}`,
      reference,
    };
  }

  async verifyPayment(reference: string): Promise<PaymentVerificationResult> {
    this.recordCall('verifyPayment', reference);

    if (this.hasScriptedOutcome('verifyPayment')) {
      return this.getNextOutcome<PaymentVerificationResult>('verifyPayment')!;
    }

    const payment = this.payments.get(reference);

    if (!payment) {
      return {
        success: false,
        error: 'Payment not found',
      };
    }

    // Auto-mark as success for fake
    payment.status = 'success';

    return {
      success: true,
      status: payment.status,
      amount: payment.amountKobo,
      reference,
      paidAt: new Date(),
    };
  }

  async refundPayment(reference: string, amountKobo?: number): Promise<RefundResult> {
    this.recordCall('refundPayment', reference, amountKobo);

    if (this.hasScriptedOutcome('refundPayment')) {
      return this.getNextOutcome<RefundResult>('refundPayment')!;
    }

    return {
      success: true,
      refundId: `fake-refund-${Date.now()}`,
    };
  }

  override reset(): void {
    super.reset();
    this.payments.clear();
  }
}

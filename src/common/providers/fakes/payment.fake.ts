/**
 * Fake payment provider for testing.
 *
 * A transaction starts as `pending`. `markPaid` / `markFailed` stand in for the
 * customer finishing checkout, so tests can drive webhook and verify flows.
 * `verifyWebhookSignature` accepts the signature `fake-valid-signature` only.
 */

import { Injectable } from '@nestjs/common';
import { BaseFake } from './base.fake.js';
import {
  ChargeAuthorizationInput,
  InitializeTransactionInput,
  InitializeTransactionResult,
  IPaymentProvider,
  RefundInput,
  RefundResult,
  TransactionStatus,
  VerifyTransactionResult,
} from '../payment.provider.js';

export const FAKE_VALID_WEBHOOK_SIGNATURE = 'fake-valid-signature';

interface FakeTransaction {
  amountKobo: number;
  email: string;
  status: TransactionStatus;
  paidAt?: Date;
  authorizationCode?: string;
}

@Injectable()
export class FakePaymentProvider extends BaseFake implements IPaymentProvider {
  private transactions = new Map<string, FakeTransaction>();

  async initializeTransaction(
    input: InitializeTransactionInput,
  ): Promise<InitializeTransactionResult> {
    this.recordCall('initializeTransaction', input);

    if (this.hasScriptedOutcome('initializeTransaction')) {
      return this.getNextOutcome<InitializeTransactionResult>('initializeTransaction')!;
    }

    this.transactions.set(input.reference, {
      amountKobo: input.amountKobo,
      email: input.email,
      status: 'pending',
    });

    return {
      authorizationUrl: `https://fake-paystack.local/pay/${input.reference}`,
      accessCode: `fake-access-${input.reference}`,
      reference: input.reference,
    };
  }

  async verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
    this.recordCall('verifyTransaction', reference);

    if (this.hasScriptedOutcome('verifyTransaction')) {
      return this.getNextOutcome<VerifyTransactionResult>('verifyTransaction')!;
    }

    const transaction = this.transactions.get(reference);
    if (!transaction) {
      return { status: 'abandoned', reference, amountKobo: 0 };
    }

    return {
      status: transaction.status,
      reference,
      amountKobo: transaction.amountKobo,
      paidAt: transaction.paidAt,
      authorizationCode: transaction.authorizationCode,
      customerEmail: transaction.email,
    };
  }

  async chargeAuthorization(
    input: ChargeAuthorizationInput,
  ): Promise<VerifyTransactionResult> {
    this.recordCall('chargeAuthorization', input);

    if (this.hasScriptedOutcome('chargeAuthorization')) {
      return this.getNextOutcome<VerifyTransactionResult>('chargeAuthorization')!;
    }

    const paidAt = new Date();
    this.transactions.set(input.reference, {
      amountKobo: input.amountKobo,
      email: input.email,
      status: 'success',
      paidAt,
      authorizationCode: input.authorizationCode,
    });

    return {
      status: 'success',
      reference: input.reference,
      amountKobo: input.amountKobo,
      paidAt,
      authorizationCode: input.authorizationCode,
      customerEmail: input.email,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    this.recordCall('refund', input);

    if (this.hasScriptedOutcome('refund')) {
      return this.getNextOutcome<RefundResult>('refund')!;
    }

    return { providerRefundRef: `fake-refund-${input.reference}`, status: 'processed' };
  }

  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
    this.recordCall('verifyWebhookSignature', rawBody.length, signature);
    return signature === FAKE_VALID_WEBHOOK_SIGNATURE;
  }

  /** Test helper: the customer completed checkout. */
  markPaid(reference: string, authorizationCode = 'AUTH_fake'): void {
    const transaction = this.transactions.get(reference);
    if (!transaction) {
      throw new Error(`Unknown reference: ${reference}`);
    }
    transaction.status = 'success';
    transaction.paidAt = new Date();
    transaction.authorizationCode = authorizationCode;
  }

  /** Test helper: the payment failed. */
  markFailed(reference: string): void {
    const transaction = this.transactions.get(reference);
    if (!transaction) {
      throw new Error(`Unknown reference: ${reference}`);
    }
    transaction.status = 'failed';
  }

  override reset(): void {
    super.reset();
    this.transactions.clear();
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { FORBIDDEN, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { PAYMENT_PROVIDER, type IPaymentProvider } from '../common/providers/payment.provider.js';
import { PaymentSettlementService } from './payment-settlement.service.js';
import { RefundService } from './refund.service.js';
import { PAYMENT_PROVIDER_NAME } from './order.service.js';

export type WebhookResult = 'processed' | 'duplicate' | 'ignored';

interface PaystackEvent {
  event?: string;
  data?: { id?: number | string; reference?: string; transaction_reference?: string; status?: string };
}

/**
 * Gateway webhooks (Backend PRD 22.2). A webhook is a hint to ask the gateway, never a fact.
 *
 *  1. The signature is checked against the raw body, in constant time. A bad one is recorded and
 *     refused; nothing else happens.
 *  2. Every event is stored once, by (provider, event id). A repeat is acknowledged, not
 *     processed again, and counted.
 *  3. A payment event is settled through `PaymentSettlementService`, which asks the gateway.
 *  4. A failure is recorded and raised, so the gateway retries; the stored row lets the retry run.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settlement: PaymentSettlementService,
    private readonly refunds: RefundService,
    @Inject(PAYMENT_PROVIDER) private readonly gateway: IPaymentProvider,
  ) {}

  async handle(rawBody: Buffer, signature: string | undefined): Promise<WebhookResult> {
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');

    if (!signature || !this.gateway.verifyWebhookSignature(rawBody, signature)) {
      await this.prisma.$executeRaw`
        INSERT INTO webhook_events (provider, event_id, event_type, signature_valid, processing_status, payload_hash, failure_reason)
        VALUES (${PAYMENT_PROVIDER_NAME}, ${`invalid:${payloadHash}`}, 'unknown', FALSE, 'FAILED'::"WebhookProcessingStatus", ${payloadHash}, 'INVALID_SIGNATURE')
        ON CONFLICT (provider, event_id) DO UPDATE SET duplicate_count = webhook_events.duplicate_count + 1
      `;
      throw DomainException.of(FORBIDDEN, { message: 'The signature is not valid.' });
    }

    let event: PaystackEvent;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as PaystackEvent;
    } catch {
      throw DomainException.of(VALIDATION_ERROR, { message: 'The body is not JSON.' });
    }
    const type = event.event ?? 'unknown';
    const reference = event.data?.reference ?? event.data?.transaction_reference;
    const eventId = `${type}:${event.data?.id ?? reference ?? payloadHash}`;

    const stored = await this.prisma.$queryRaw<Array<{ inserted: boolean; status: string }>>`
      INSERT INTO webhook_events (provider, event_id, event_type, signature_valid, processing_status, payload_hash)
      VALUES (${PAYMENT_PROVIDER_NAME}, ${eventId}, ${type}, TRUE, 'RECEIVED'::"WebhookProcessingStatus", ${payloadHash})
      ON CONFLICT (provider, event_id)
      DO UPDATE SET duplicate_count = webhook_events.duplicate_count + 1
      RETURNING (xmax = 0) AS inserted, processing_status::text AS status
    `;
    const row = stored[0];
    if (!row.inserted && ['PROCESSED', 'IGNORED_DUPLICATE'].includes(row.status)) {
      // Already handled: acknowledge it. The conflict above counted it; nothing runs a second time.
      return 'duplicate';
    }

    try {
      const result = await this.dispatch(type, event, reference);
      await this.prisma.$executeRaw`
        UPDATE webhook_events
        SET processing_status = 'PROCESSED'::"WebhookProcessingStatus", processed_at = clock_timestamp(), failure_reason = NULL
        WHERE provider = ${PAYMENT_PROVIDER_NAME} AND event_id = ${eventId}
      `;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Webhook ${eventId} failed: ${message}`);
      await this.prisma.$executeRaw`
        UPDATE webhook_events
        SET processing_status = 'FAILED'::"WebhookProcessingStatus", failure_reason = ${message.slice(0, 500)}
        WHERE provider = ${PAYMENT_PROVIDER_NAME} AND event_id = ${eventId}
      `;
      // The gateway retries on an error answer; the row above lets the retry run again.
      throw error;
    }
  }

  private async dispatch(type: string, event: PaystackEvent, reference: string | undefined): Promise<WebhookResult> {
    if (type === 'charge.success' && reference) {
      await this.settlement.settle(reference, 'WEBHOOK');
      return 'processed';
    }
    if ((type === 'refund.processed' || type === 'refund.failed') && event.data?.id !== undefined) {
      await this.refunds.onProviderEvent(String(event.data.id), type === 'refund.processed' ? 'processed' : 'failed');
      return 'processed';
    }
    return 'ignored';
  }
}

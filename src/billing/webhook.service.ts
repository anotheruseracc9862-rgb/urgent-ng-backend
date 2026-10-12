import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { FORBIDDEN, VALIDATION_ERROR, RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
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
      INSERT INTO webhook_events (provider, event_id, event_type, signature_valid, processing_status, payload_hash, payload_ref)
      VALUES (${PAYMENT_PROVIDER_NAME}, ${eventId}, ${type}, TRUE, 'RECEIVED'::"WebhookProcessingStatus", ${payloadHash},
              ${reference ?? (event.data?.id !== undefined ? String(event.data.id) : null)})
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

  /**
   * An admin runs a stored event again (it failed, or the gateway never retried). The raw body is
   * not kept: the event's reference is, and the handlers all start by asking the gateway, so a
   * replay settles exactly what the original would have and a second replay changes nothing.
   */
  async replay(webhookEventId: string): Promise<{ status: string; replayed: boolean }> {
    const rows = await this.prisma.$queryRaw<Array<{ event_type: string; payload_ref: string | null; signature_valid: boolean; status: string }>>`
      SELECT event_type, payload_ref, signature_valid, processing_status::text AS status
      FROM webhook_events WHERE id = ${webhookEventId}::uuid
    `;
    const row = rows[0];
    if (!row) throw DomainException.of(RESOURCE_NOT_FOUND);
    if (!row.signature_valid || !row.payload_ref) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'This event has nothing that can be replayed.', details: { reason: 'NO_REFERENCE' } });
    }
    const event: PaystackEvent = row.event_type.startsWith('refund.')
      ? { event: row.event_type, data: { id: Number(row.payload_ref) } }
      : { event: row.event_type, data: { reference: row.payload_ref } };
    const result = await this.dispatch(row.event_type, event, row.payload_ref);
    await this.prisma.$executeRaw`
      UPDATE webhook_events
      SET processing_status = 'PROCESSED'::"WebhookProcessingStatus", processed_at = clock_timestamp(), failure_reason = NULL
      WHERE id = ${webhookEventId}::uuid
    `;
    return { status: result, replayed: true };
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

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

/** The business events of Backend PRD 28.2. */
export const ANALYTICS_EVENT_NAMES = [
  'USER_REGISTERED',
  'ERRAND_CREATED',
  'ERRAND_PUBLISHED',
  'OFFER_CREATED',
  'OFFER_SELECTED',
  'ASSIGNMENT_ACCEPTED',
  'ERRAND_STARTED',
  'ERRAND_DELIVERED',
  'ERRAND_COMPLETED',
  'ERRAND_CANCELLED',
  'USER_VERIFIED',
  'RUNNER_PRO_PURCHASED',
  'BOOST_PURCHASED',
  'REPORT_CREATED',
  'DISPUTE_CREATED',
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

/**
 * A property is kept only when it is a short scalar and its key is not one that could carry
 * personal text. Anything else is dropped, so a careless caller cannot leak an address, a phone
 * number or a message (Backend PRD 28.2).
 */
const FORBIDDEN_KEY =
  /address|phone|email|body|message|text|note|description|instruction|title|name|street|landmark|lat|lng|longitude|latitude|location|contact|token|password/i;
const MAX_STRING = 64;

export function cleanProperties(input: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && value.length <= MAX_STRING) out[key] = value;
  }
  return out;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record one event. `sourceEventId` (the outbox event) makes the call idempotent: a retried
   * job writes nothing the second time. Returns whether a row was written.
   */
  async record(input: {
    name: AnalyticsEventName;
    userId?: string | null;
    properties?: Record<string, unknown>;
    sourceEventId?: string | null;
    occurredAt?: Date;
  }): Promise<boolean> {
    const props = JSON.stringify(cleanProperties(input.properties ?? {}));
    const count = await this.prisma.$executeRaw`
      INSERT INTO analytics_events (name, user_id, properties, source_event_id, occurred_at)
      VALUES (${input.name}, ${input.userId ?? null}::uuid, ${props}::jsonb, ${input.sourceEventId ?? null}::uuid,
              COALESCE(${input.occurredAt ?? null}::timestamptz, clock_timestamp()))
      ON CONFLICT (source_event_id) DO NOTHING
    `;
    return count > 0;
  }
}

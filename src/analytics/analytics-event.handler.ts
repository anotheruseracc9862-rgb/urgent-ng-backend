import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { EventDispatcher, type DomainEvent, type DomainEventHandler } from '../queue/event-dispatcher.js';
import { AnalyticsService, type AnalyticsEventName } from './analytics.service.js';

type Payload = Record<string, unknown>;
const str = (p: Payload, key: string): string | null => (typeof p[key] === 'string' ? (p[key] as string) : null);

interface Mapped {
  name: AnalyticsEventName;
  userId: string | null;
  properties: Record<string, unknown>;
  /** Look the errand's category up (the event does not carry it). */
  withErrand?: string | null;
}

/** Which outbox event becomes which analytics event, and which fields it keeps (Backend PRD 28.2). */
function map(event: DomainEvent): Mapped | null {
  const p = event.payload;
  switch (event.eventType) {
    case 'user.created':
      return { name: 'USER_REGISTERED', userId: str(p, 'userId'), properties: { method: str(p, 'method') } };
    case 'errand.created':
      return { name: 'ERRAND_CREATED', userId: str(p, 'requesterId'), properties: { categoryId: str(p, 'categoryId') } };
    case 'errand.published':
      return { name: 'ERRAND_PUBLISHED', userId: str(p, 'requesterId'), properties: {}, withErrand: str(p, 'errandId') };
    case 'offer.created':
      return {
        name: 'OFFER_CREATED',
        userId: str(p, 'runnerId'),
        properties: { amountMinor: p.amountMinor, durationMinutes: p.durationMinutes },
        withErrand: str(p, 'errandId'),
      };
    case 'offer.updated':
      if (p.action !== 'offer.selected') return null;
      return { name: 'OFFER_SELECTED', userId: str(p, 'requesterId'), properties: { amountMinor: p.amountMinor }, withErrand: str(p, 'errandId') };
    case 'assignment.accepted':
      return {
        name: 'ASSIGNMENT_ACCEPTED',
        userId: str(p, 'runnerId'),
        properties: { agreedAmountMinor: p.agreedAmountMinor },
        withErrand: str(p, 'errandId'),
      };
    case 'execution.started':
      return { name: 'ERRAND_STARTED', userId: str(p, 'runnerId'), properties: {}, withErrand: str(p, 'errandId') };
    case 'execution.delivered':
      return { name: 'ERRAND_DELIVERED', userId: str(p, 'runnerId'), properties: {}, withErrand: str(p, 'errandId') };
    case 'errand.completed':
      return { name: 'ERRAND_COMPLETED', userId: str(p, 'requesterId'), properties: {}, withErrand: str(p, 'errandId') };
    case 'errand.cancelled':
      return {
        name: 'ERRAND_CANCELLED',
        userId: str(p, 'requesterId'),
        properties: { actorType: str(p, 'actorType'), from: str(p, 'from') },
        withErrand: str(p, 'errandId'),
      };
    case 'verification.completed':
      return { name: 'USER_VERIFIED', userId: str(p, 'userId'), properties: {} };
    case 'subscription.activated':
      // An admin grant is not a purchase.
      if (p.byAdmin === true || str(p, 'orderId') === null) return null;
      return { name: 'RUNNER_PRO_PURCHASED', userId: str(p, 'userId'), properties: { extended: p.extended === true } };
    case 'boost.activated':
      return { name: 'BOOST_PURCHASED', userId: str(p, 'userId'), properties: {}, withErrand: str(p, 'errandId') };
    case 'report.created':
      return { name: 'REPORT_CREATED', userId: str(p, 'reporterId'), properties: { type: str(p, 'type'), targetType: str(p, 'targetType') } };
    case 'dispute.created':
      return { name: 'DISPUTE_CREATED', userId: str(p, 'openedBy'), properties: { type: str(p, 'type') }, withErrand: str(p, 'errandId') };
    default:
      return null;
  }
}

/** Turns domain events into analytics rows. Idempotent by outbox event id. */
@Injectable()
export class AnalyticsEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = 'AnalyticsEventHandler';

  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: DomainEvent): Promise<void> {
    const mapped = map(event);
    if (!mapped) return;
    const properties = { ...mapped.properties };
    if (mapped.withErrand) {
      const rows = await this.prisma.$queryRaw<Array<{ category_id: string; priority: string }>>`
        SELECT category_id::text, priority::text FROM errands WHERE id = ${mapped.withErrand}::uuid
      `;
      if (rows[0]) {
        properties.categoryId = rows[0].category_id;
        properties.priority = rows[0].priority;
      }
    }
    await this.analytics.record({
      name: mapped.name,
      userId: mapped.userId,
      properties,
      sourceEventId: event.eventId,
      occurredAt: new Date(event.occurredAt),
    });
  }
}

import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { EventDispatcher, type DomainEvent, type DomainEventHandler } from '../queue/event-dispatcher.js';
import { BoostService } from './boost.service.js';

/**
 * Ends a boost when the errand stops being open to runners: a runner was selected, or it was
 * cancelled or expired (Backend PRD 22.5). A boost is not brought back if the errand reopens.
 * Ending is idempotent: nothing live means nothing changes.
 */
@Injectable()
export class BoostEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = 'BoostEventHandler';

  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly prisma: PrismaService,
    private readonly boosts: BoostService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: DomainEvent): Promise<void> {
    if (!['errand.status_changed', 'errand.cancelled', 'errand.expired'].includes(event.eventType)) return;
    const errandId = event.payload.errandId;
    const to = event.payload.to;
    if (typeof errandId !== 'string') return;
    // A move that keeps the errand OPEN (an edit, an extension) is not an end.
    if (to === 'OPEN') return;
    const reason =
      to === 'RUNNER_SELECTED' ? 'RUNNER_SELECTED' : to === 'CANCELLED' ? 'ERRAND_CANCELLED' : to === 'EXPIRED' ? 'ERRAND_EXPIRED' : 'ERRAND_LEFT_OPEN';
    await this.prisma.$transaction(async (tx) => {
      await this.boosts.endForErrand(tx, errandId, reason);
    });
  }
}

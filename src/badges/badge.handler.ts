import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { EventDispatcher, type DomainEvent, type DomainEventHandler } from '../queue/event-dispatcher.js';
import { BadgeService } from './badge.service.js';

const str = (p: Record<string, unknown>, key: string): string | undefined => (typeof p[key] === 'string' ? (p[key] as string) : undefined);

/**
 * Recomputes badges when something that feeds a rule changes (Backend PRD 21.5): a completed
 * errand, a revealed rating, a reliability fact, an enforcement action, a verification outcome.
 * Recomputing derives from source rows, so a repeated or reordered event changes nothing.
 */
@Injectable()
export class BadgeEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = 'BadgeEventHandler';

  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly prisma: PrismaService,
    private readonly badges: BadgeService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload;
    const users = new Set<string>();
    const add = (id: string | undefined) => {
      if (id) users.add(id);
    };

    switch (event.eventType) {
      case 'errand.completed': {
        add(str(p, 'requesterId'));
        const errandId = str(p, 'errandId');
        if (errandId) {
          const rows = await this.prisma.$queryRaw<Array<{ runner_id: string }>>`
            SELECT runner_id::text FROM assignments WHERE errand_id = ${errandId}::uuid AND status = 'COMPLETED'::"AssignmentStatus"
          `;
          rows.forEach((r) => add(r.runner_id));
        }
        break;
      }
      case 'errand.published':
        add(str(p, 'requesterId'));
        break;
      case 'rating.revealed':
        add(str(p, 'rateeId'));
        break;
      case 'reliability.recorded':
      case 'enforcement.applied':
      case 'enforcement.expired':
      case 'enforcement.revoked':
      case 'verification.completed':
      case 'verification.revoked':
      case 'verification.expired':
      case 'subscription.activated':
      case 'subscription.expired':
        add(str(p, 'userId'));
        break;
      case 'assignment.cancelled':
        // A runner cancelling moves the cancellation rate; the reliability fact follows too.
        add(str(p, 'runnerId'));
        break;
      default:
        return;
    }
    for (const userId of users) {
      await this.badges.recompute(userId);
    }
  }
}

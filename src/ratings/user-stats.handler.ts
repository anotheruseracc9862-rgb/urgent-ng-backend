import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { EventDispatcher, type DomainEvent, type DomainEventHandler } from '../queue/event-dispatcher.js';
import { UserStatsService } from './user-stats.service.js';

/**
 * Keeps `user_stats` current: a completed errand changes both parties' completed counts. The
 * rebuild reads source rows, so a retried or repeated event gives the same row (idempotent).
 * Rating figures are rebuilt when a rating is revealed (RatingService).
 */
@Injectable()
export class UserStatsEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = 'UserStatsEventHandler';

  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly prisma: PrismaService,
    private readonly stats: UserStatsService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: DomainEvent): Promise<void> {
    if (event.eventType !== 'errand.completed') return;
    const errandId = event.payload.errandId;
    if (typeof errandId !== 'string') return;
    const rows = await this.prisma.$queryRaw<Array<{ requester_id: string; runner_id: string }>>`
      SELECT requester_id::text, runner_id::text FROM assignments
      WHERE errand_id = ${errandId}::uuid AND status = 'COMPLETED'::"AssignmentStatus" AND deleted_at IS NULL
    `;
    for (const row of rows) {
      await this.stats.recompute(this.prisma, row.requester_id);
      await this.stats.recompute(this.prisma, row.runner_id);
    }
  }
}

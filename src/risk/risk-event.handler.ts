import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { EventDispatcher, type DomainEvent, type DomainEventHandler } from '../queue/event-dispatcher.js';
import { RiskFlagService } from './risk-flag.service.js';

const str = (p: Record<string, unknown>, key: string): string | undefined => (typeof p[key] === 'string' ? (p[key] as string) : undefined);

/**
 * The signals that come from marketplace events (Backend PRD 21.6). Each one only raises a flag
 * for an admin to look at; none of them restricts anyone. Raising is idempotent while a flag is
 * open, so a retried event adds a count at most.
 *
 * OTP abuse and feed probing are raised where they happen (the OTP service, the marketplace),
 * because they have no event.
 */
@Injectable()
export class RiskEventHandler implements DomainEventHandler, OnModuleInit {
  readonly name = 'RiskEventHandler';

  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly flags: RiskFlagService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload;
    switch (event.eventType) {
      case 'offer.created':
        return this.offerSpam(str(p, 'runnerId'));
      case 'rating.revealed':
        return this.ratingAnomaly(str(p, 'rateeId'));
      case 'errand.completed':
        return this.selfDealing(str(p, 'errandId'));
      case 'runner_location.anomaly':
        return this.locationAnomaly(p);
      default:
        return;
    }
  }

  /** A runner submitting offers far faster than anyone reads them. */
  private async offerSpam(runnerId: string | undefined): Promise<void> {
    if (!runnerId) return;
    const limit = await this.config.get('RISK_OFFER_SPAM_PER_HOUR');
    const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM offers
      WHERE runner_id = ${runnerId}::uuid AND created_at > clock_timestamp() - interval '1 hour'
    `;
    if (rows[0].n >= limit) {
      await this.flags.raise(this.prisma, { signal: 'OFFER_SPAM', userId: runnerId, details: { offersInLastHour: rows[0].n, threshold: limit } });
    }
  }

  /** A cluster of very low ratings on one person in a short time: a pile-on, or retaliation. */
  private async ratingAnomaly(rateeId: string | undefined): Promise<void> {
    if (!rateeId) return;
    const [count, maxScore, days] = await Promise.all([
      this.config.get('RISK_LOW_RATING_COUNT'),
      this.config.get('RISK_LOW_RATING_MAX_SCORE'),
      this.config.get('RISK_LOW_RATING_WINDOW_DAYS'),
    ]);
    const rows = await this.prisma.$queryRaw<Array<{ n: number; raters: number }>>`
      SELECT count(*)::int AS n, count(DISTINCT r.rater_id)::int AS raters
      FROM ratings r
      JOIN rating_scores s ON s.rating_id = r.id AND s.dimension = 'OVERALL'::"RatingDimension"
      WHERE r.ratee_id = ${rateeId}::uuid AND r.deleted_at IS NULL AND r.revealed_at IS NOT NULL
        AND s.score <= ${maxScore}::int
        AND r.created_at > clock_timestamp() - make_interval(days => ${days}::int)
    `;
    if (rows[0].n >= count) {
      await this.flags.raise(this.prisma, {
        signal: 'RATING_ANOMALY',
        userId: rateeId,
        details: { lowRatings: rows[0].n, distinctRaters: rows[0].raters, maxScore, windowDays: days },
      });
    }
  }

  /** The same two accounts completing errand after errand together: a collusion pattern. */
  private async selfDealing(errandId: string | undefined): Promise<void> {
    if (!errandId) return;
    const [count, days] = await Promise.all([this.config.get('RISK_REPEAT_PAIR_COUNT'), this.config.get('RISK_REPEAT_PAIR_DAYS')]);
    const pair = await this.prisma.$queryRaw<Array<{ requester_id: string; runner_id: string }>>`
      SELECT requester_id::text, runner_id::text FROM assignments
      WHERE errand_id = ${errandId}::uuid AND status = 'COMPLETED'::"AssignmentStatus" AND deleted_at IS NULL
      LIMIT 1
    `;
    if (!pair[0]) return;
    const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM assignments
      WHERE requester_id = ${pair[0].requester_id}::uuid AND runner_id = ${pair[0].runner_id}::uuid
        AND status = 'COMPLETED'::"AssignmentStatus" AND deleted_at IS NULL
        AND completed_at > clock_timestamp() - make_interval(days => ${days}::int)
    `;
    if (rows[0].n >= count) {
      // Flag the runner; the counterparty is in the details so a reviewer sees both sides.
      await this.flags.raise(this.prisma, {
        signal: 'SELF_DEALING',
        userId: pair[0].runner_id,
        errandId,
        details: { counterpartyUserId: pair[0].requester_id, completedTogether: rows[0].n, windowDays: days },
      });
    }
  }

  /** A position jump no vehicle could make, reported by the location service. A signal, not proof. */
  private async locationAnomaly(p: Record<string, unknown>): Promise<void> {
    const userId = str(p, 'userId');
    const errandId = str(p, 'errandId');
    if (!userId) return;
    await this.flags.raise(this.prisma, {
      signal: 'LOCATION_ANOMALY',
      userId,
      errandId: errandId ?? null,
      details: {
        kind: str(p, 'signal') ?? 'LOCATION_JUMP',
        meters: typeof p.meters === 'number' ? p.meters : null,
        seconds: typeof p.seconds === 'number' ? p.seconds : null,
      },
    });
  }
}

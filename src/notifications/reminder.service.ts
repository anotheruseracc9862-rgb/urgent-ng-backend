import { Injectable, Logger } from '@nestjs/common';
import { formatInTimeZone } from 'date-fns-tz';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { NotificationService } from './notification.service.js';

/** Rating reminders go out this many hours after completion (Backend PRD 20.3, Build Plan P8-05). */
const RATING_REMINDER_HOURS = [24, 72] as const;
const BATCH = 200;

export interface ReminderCounts {
  acceptanceWarnings: number;
  errandExpiring: number;
  ratingReminders: number;
}

/**
 * Scheduled reminders (Backend PRD 19.1, P8-05). Time is a database fact, so these are found by a
 * sweeper query, not by a delayed job that a Redis flush would lose. Each one carries a
 * deterministic dedupe key, so a repeated sweep sends nothing new: "each fires once". Preferences
 * and quiet hours are applied by the notification engine.
 *
 * - acceptance deadline warning: the selected runner, shortly before the window ends;
 * - errand expiring: the requester, shortly before an open errand closes;
 * - rating reminders: both parties, 24 h and 72 h after completion, until they have rated.
 */
@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly notifications: NotificationService,
  ) {}

  async run(): Promise<ReminderCounts> {
    return {
      acceptanceWarnings: await this.acceptanceWarnings(),
      errandExpiring: await this.errandExpiring(),
      ratingReminders: await this.ratingReminders(),
    };
  }

  private async acceptanceWarnings(): Promise<number> {
    const minutes = await this.config.get('ACCEPTANCE_WARNING_MINUTES');
    const rows = await this.prisma.$queryRaw<Array<{ id: string; errand_id: string; runner_id: string; title: string; deadline: Date }>>`
      SELECT a.id::text, a.errand_id::text, a.runner_id::text, e.title, a.acceptance_deadline AS deadline
      FROM assignments a JOIN errands e ON e.id = a.errand_id
      WHERE a.status = 'PENDING_ACCEPTANCE'::"AssignmentStatus" AND a.deleted_at IS NULL
        AND a.acceptance_deadline > clock_timestamp()
        AND a.acceptance_deadline <= clock_timestamp() + make_interval(mins => ${minutes}::int)
      ORDER BY a.acceptance_deadline
      LIMIT ${BATCH}
    `;
    let sent = 0;
    for (const row of rows) {
      const result = await this.notifications.notify({
        userId: row.runner_id,
        template: 'assignment.acceptance_warning',
        vars: { errandTitle: row.title, deadline: formatInTimeZone(row.deadline, 'Africa/Lagos', 'HH:mm') },
        data: { assignmentId: row.id, errandId: row.errand_id },
        dedupeKey: `assignment:${row.id}:acceptance-warning`,
      });
      if (result.created) sent += 1;
    }
    return sent;
  }

  private async errandExpiring(): Promise<number> {
    const minutes = await this.config.get('ERRAND_EXPIRING_WARNING_MINUTES');
    const rows = await this.prisma.$queryRaw<Array<{ id: string; requester_id: string; title: string; expires_at: Date }>>`
      SELECT e.id::text, e.requester_id::text, e.title, e.expires_at
      FROM errands e
      WHERE e.status = 'OPEN'::"ErrandStatus" AND e.deleted_at IS NULL
        AND e.expires_at > clock_timestamp()
        AND e.expires_at <= clock_timestamp() + make_interval(mins => ${minutes}::int)
      ORDER BY e.expires_at
      LIMIT ${BATCH}
    `;
    let sent = 0;
    for (const row of rows) {
      const result = await this.notifications.notify({
        userId: row.requester_id,
        template: 'errand.expiring',
        vars: { errandTitle: row.title, deadline: formatInTimeZone(row.expires_at, 'Africa/Lagos', 'HH:mm') },
        data: { errandId: row.id },
        // The deadline moves when an errand is extended, so the key includes it: a new deadline may warn again.
        dedupeKey: `errand:${row.id}:expiring:${row.expires_at.getTime()}`,
      });
      if (result.created) sent += 1;
    }
    return sent;
  }

  /**
   * Both parties of a completed assignment, at 24 h and 72 h, within the rating window. Each
   * reminder is only for its own hour band, so a sweeper that was down does not send a stale "24 h"
   * reminder on day three.
   */
  private async ratingReminders(): Promise<number> {
    const windowDays = await this.config.get('RATING_WINDOW_DAYS');
    let sent = 0;
    for (const [index, hours] of RATING_REMINDER_HOURS.entries()) {
      const nextHours = RATING_REMINDER_HOURS[index + 1] ?? windowDays * 24;
      const rows = await this.prisma.$queryRaw<Array<{ id: string; errand_id: string; requester_id: string; runner_id: string; title: string }>>`
        SELECT a.id::text, a.errand_id::text, a.requester_id::text, a.runner_id::text, e.title
        FROM assignments a JOIN errands e ON e.id = a.errand_id
        WHERE a.status = 'COMPLETED'::"AssignmentStatus" AND a.deleted_at IS NULL
          AND a.completed_at <= clock_timestamp() - make_interval(hours => ${hours}::int)
          AND a.completed_at > clock_timestamp() - make_interval(hours => ${nextHours}::int)
        ORDER BY a.completed_at
        LIMIT ${BATCH}
      `;
      for (const row of rows) {
        for (const userId of [row.requester_id, row.runner_id]) {
          if (await this.hasRated(row.id, userId)) continue;
          const result = await this.notifications.notify({
            userId,
            template: 'rating.reminder',
            vars: { errandTitle: row.title },
            data: { assignmentId: row.id, errandId: row.errand_id },
            dedupeKey: `assignment:${row.id}:rating-reminder:${hours}h:${userId}`,
          });
          if (result.created) sent += 1;
        }
      }
    }
    return sent;
  }

  /** Ratings arrive with Phase 9 (P9-01); until then nobody has rated. */
  private async hasRated(_assignmentId: string, _userId: string): Promise<boolean> {
    return false;
  }
}

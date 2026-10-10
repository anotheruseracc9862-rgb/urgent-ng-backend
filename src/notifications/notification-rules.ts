import { Injectable } from '@nestjs/common';
import { formatInTimeZone } from 'date-fns-tz';
import { PrismaService } from '../database/prisma.service.js';
import type { DomainEvent } from '../queue/event-dispatcher.js';
import { formatNaira } from './notification-templates.js';

/** What one event asks the notification engine to do for one user. */
export interface NotificationIntent {
  userId: string;
  /** Key in the template registry. */
  template: string;
  /** Values for the template placeholders. */
  vars: Record<string, string>;
  /** Entity ids for the client's deep link. Never sensitive data. */
  data: Record<string, string | number | boolean | null>;
  /** Deterministic key: the same fact never produces two notifications (Backend PRD 19.3). */
  dedupeKey: string;
  /** Spend from an hourly push allowance; over it the push is suppressed and the in-app notice stays. */
  pushCap?: { key: string; limit: number };
  /** A muted conversation produces no notification. */
  conversationId?: string;
}

const str = (payload: Record<string, unknown>, key: string): string | undefined => {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
};
const num = (payload: Record<string, unknown>, key: string): number | undefined => {
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
};

/**
 * Turns a domain event into notification intents: who is told, with which template (Backend PRD
 * 19.1). Pure of side effects; it only reads names and titles to fill the copy. Events that the
 * client learns about some other way (the selected offer, a completed assignment) produce nothing.
 */
@Injectable()
export class NotificationRules {
  constructor(private readonly prisma: PrismaService) {}

  async intentsFor(event: DomainEvent): Promise<NotificationIntent[]> {
    const p = event.payload;
    switch (event.eventType) {
      case 'offer.created':
        return this.offerCreated(p);
      case 'offer.updated':
        return this.offerUpdated(p);
      case 'offer.withdrawn':
        return this.toRequester(p, 'offer.withdrawn', `offer:${str(p, 'offerId')}:withdrawn`, { runnerNameOf: 'runnerId' });
      case 'offer.rejected':
        return this.toRunner(p, 'offer.declined', `offer:${str(p, 'offerId')}:rejected`);
      case 'offer.closed':
        return this.offerClosed(p);
      case 'assignment.selected':
        return this.assignmentSelected(p);
      case 'assignment.accepted':
        return this.toRequester(p, 'assignment.accepted', `assignment:${str(p, 'assignmentId')}:accepted`, { runnerNameOf: 'runnerId' });
      case 'assignment.declined':
        return this.toRequester(p, 'assignment.declined', `assignment:${str(p, 'assignmentId')}:declined`, { runnerNameOf: 'runnerId' });
      case 'assignment.timed_out':
        return [
          ...(await this.toRequester(p, 'assignment.timed_out.requester', `assignment:${str(p, 'assignmentId')}:timed_out:requester`, { runnerNameOf: 'runnerId' })),
          ...(await this.toRunner(p, 'assignment.timed_out.runner', `assignment:${str(p, 'assignmentId')}:timed_out:runner`)),
        ];
      case 'assignment.cancelled':
        return this.assignmentCancelled(p);
      case 'execution.started':
      case 'execution.picked_up':
      case 'execution.delivered':
        return this.toRequester(p, event.eventType, `assignment:${str(p, 'assignmentId')}:${event.eventType}`, { runnerNameOf: 'runnerId' });
      case 'execution.delay_notified':
        return this.toRequester(p, 'execution.delayed', `assignment:${str(p, 'assignmentId')}:delay:${num(p, 'notice') ?? event.eventId}`, {
          runnerNameOf: 'runnerId',
          extraVars: { minutes: String(num(p, 'newEstimateMinutes') ?? '') },
        });
      case 'execution.problem_reported':
        return this.toRequester(p, 'execution.problem_reported', `assignment:${str(p, 'assignmentId')}:problem:${str(p, 'problemId')}`, { runnerNameOf: 'runnerId' });
      case 'execution.problem_resolved':
        return this.toRequester(p, 'execution.problem_resolved', `assignment:${str(p, 'assignmentId')}:problem-resolved:${str(p, 'problemId')}`, {});
      case 'execution.receipt_added':
        return this.toRequester(p, 'execution.receipt_added', `assignment:${str(p, 'assignmentId')}:receipt:${num(p, 'receipt') ?? event.eventId}`, { runnerNameOf: 'runnerId' });
      case 'errand.completed':
        return this.errandCompleted(event);
      case 'errand.expired':
        return this.toRequester(p, 'errand.expired', `errand:${str(p, 'errandId')}:expired`, { errandIdKey: 'errandId' });
      case 'errand.cancelled':
        return str(p, 'actorType') === 'ADMIN' || str(p, 'actorType') === 'SYSTEM'
          ? this.toRequester(p, 'errand.cancelled.by_platform', `errand:${str(p, 'errandId')}:cancelled-by-platform`, { errandIdKey: 'errandId' })
          : [];
      case 'change_request.created':
      case 'change_request.accepted':
      case 'change_request.rejected':
      case 'change_request.cancelled':
      case 'change_request.expired':
        return this.changeRequest(event);
      case 'payment_agreement.updated':
        return this.paymentAgreement(event);
      case 'verification.completed':
      case 'verification.failed':
      case 'verification.expired':
      case 'verification.revoked':
      case 'verification.attempts_granted':
        return this.verification(event);
      case 'message.created':
        return this.message(p);
      default:
        return [];
    }
  }

  // ---- offers ----

  private async offerCreated(p: Record<string, unknown>): Promise<NotificationIntent[]> {
    const requesterId = str(p, 'requesterId');
    const offerId = str(p, 'offerId');
    if (!requesterId || !offerId) return [];
    return [
      {
        userId: requesterId,
        template: 'offer.new',
        vars: await this.vars(p, { runnerNameOf: 'runnerId', amount: true }),
        data: this.ids(p),
        dedupeKey: `offer:${offerId}:created`,
      },
    ];
  }

  private async offerUpdated(p: Record<string, unknown>): Promise<NotificationIntent[]> {
    const offerId = str(p, 'offerId');
    const version = num(p, 'version');
    const action = str(p, 'action');
    const actorId = str(p, 'actorId');
    const requesterId = str(p, 'requesterId');
    const runnerId = str(p, 'runnerId');
    if (!offerId || !requesterId || !runnerId) return [];
    const key = `offer:${offerId}:v${version ?? 'x'}`;
    const make = async (userId: string, template: string): Promise<NotificationIntent[]> => [
      { userId, template, vars: await this.vars(p, { runnerNameOf: 'runnerId', amount: true }), data: this.ids(p), dedupeKey: `${key}:${template}` },
    ];

    switch (action) {
      case 'offer.edit':
        return make(requesterId, 'offer.revised');
      case 'offer.counter':
        return actorId === requesterId ? make(runnerId, 'offer.countered') : make(requesterId, 'offer.revised');
      case 'offer.accept_counter':
        return make(requesterId, 'offer.counter_accepted');
      case 'offer.reconfirm':
        return make(requesterId, 'offer.reconfirmed');
      case 'offer.flagged_for_reconfirmation':
        return make(runnerId, 'offer.reconfirm_needed');
      default:
        // offer.selected is told through assignment.selected.
        return [];
    }
  }

  private async offerClosed(p: Record<string, unknown>): Promise<NotificationIntent[]> {
    const runnerId = str(p, 'runnerId');
    const offerId = str(p, 'offerId');
    const errandId = str(p, 'errandId');
    if (!runnerId || !offerId || !errandId) return [];
    const reason = str(p, 'closeReason');
    const template =
      reason === 'RUNNER_SELECTED'
        ? 'offer.not_selected'
        : reason === 'ERRAND_CANCELLED'
          ? 'offer.errand_cancelled'
          : reason === 'ERRAND_EXPIRED'
            ? 'offer.errand_expired'
            : undefined;
    if (!template) return [];
    return [
      {
        userId: runnerId,
        template,
        vars: await this.vars(p, {}),
        data: this.ids(p),
        // Shared with assignment.cancelled so a runner is told once that the errand is cancelled.
        dedupeKey: reason === 'ERRAND_CANCELLED' ? `errand:${errandId}:cancelled:${runnerId}` : `offer:${offerId}:closed`,
      },
    ];
  }

  // ---- assignments ----

  private async assignmentSelected(p: Record<string, unknown>): Promise<NotificationIntent[]> {
    const runnerId = str(p, 'runnerId');
    const assignmentId = str(p, 'assignmentId');
    const deadline = p.acceptanceDeadline;
    if (!runnerId || !assignmentId) return [];
    const at = deadline ? new Date(deadline as string) : undefined;
    return [
      {
        userId: runnerId,
        template: 'assignment.selected',
        vars: { ...(await this.vars(p, {})), deadline: at ? formatInTimeZone(at, 'Africa/Lagos', 'HH:mm') : '' },
        data: { ...this.ids(p), acceptanceDeadline: at ? at.toISOString() : null },
        dedupeKey: `assignment:${assignmentId}:selected`,
      },
    ];
  }

  private async assignmentCancelled(p: Record<string, unknown>): Promise<NotificationIntent[]> {
    const requesterId = str(p, 'requesterId');
    const runnerId = str(p, 'runnerId');
    const assignmentId = str(p, 'assignmentId');
    const errandId = str(p, 'errandId');
    if (!requesterId || !runnerId || !assignmentId || !errandId) return [];
    const vars = await this.vars(p, { runnerNameOf: 'runnerId' });
    const data = this.ids(p);
    const by = str(p, 'actorType');
    if (by === 'REQUESTER') {
      return [{ userId: runnerId, template: 'assignment.cancelled.by_requester', vars, data, dedupeKey: `errand:${errandId}:cancelled:${runnerId}` }];
    }
    if (by === 'RUNNER') {
      return [{ userId: requesterId, template: 'assignment.cancelled.by_runner', vars, data, dedupeKey: `assignment:${assignmentId}:cancelled:${requesterId}` }];
    }
    return [requesterId, runnerId].map((userId) => ({
      userId,
      template: 'assignment.cancelled.by_platform',
      vars,
      data,
      dedupeKey: `assignment:${assignmentId}:cancelled:${userId}`,
    }));
  }

  private async errandCompleted(event: DomainEvent): Promise<NotificationIntent[]> {
    const p = event.payload;
    const errandId = str(p, 'errandId');
    const requesterId = str(p, 'requesterId');
    if (!errandId || !requesterId) return [];
    const runnerId = await this.runnerOf(errandId);
    const vars = await this.vars({ ...p, errandId, runnerId }, {});
    const data = { errandId, assignmentId: null as string | null };
    const automatic = str(p, 'actorType') === 'SYSTEM';
    const out: NotificationIntent[] = [];
    if (automatic) {
      out.push({ userId: requesterId, template: 'errand.auto_completed.requester', vars, data, dedupeKey: `errand:${errandId}:completed:${requesterId}` });
    }
    if (runnerId) {
      out.push({
        userId: runnerId,
        template: automatic ? 'errand.auto_completed.runner' : 'errand.completed.runner',
        vars,
        data,
        dedupeKey: `errand:${errandId}:completed:${runnerId}`,
      });
    }
    return out;
  }

  // ---- change requests and agreement ----

  private async changeRequest(event: DomainEvent): Promise<NotificationIntent[]> {
    const id = str(event.payload, 'changeRequestId');
    if (!id) return [];
    const rows = await this.prisma.$queryRaw<Array<{ requested_by: string; requester_id: string; runner_id: string; errand_id: string; assignment_id: string }>>`
      SELECT c.requested_by::text, a.requester_id::text, a.runner_id::text, a.errand_id::text, a.id::text AS assignment_id
      FROM change_requests c JOIN assignments a ON a.id = c.assignment_id WHERE c.id = ${id}::uuid
    `;
    const row = rows[0];
    if (!row) return [];
    const other = row.requested_by === row.requester_id ? row.runner_id : row.requester_id;
    const type = event.eventType.split('.')[1];
    const toProposer = type === 'accepted' || type === 'rejected' || type === 'expired';
    const userId = type === 'created' || type === 'cancelled' ? other : row.requested_by;
    return [
      {
        userId: toProposer ? row.requested_by : userId,
        template: event.eventType,
        vars: await this.vars({ errandId: row.errand_id }, {}),
        data: { errandId: row.errand_id, assignmentId: row.assignment_id, changeRequestId: id },
        dedupeKey: `change-request:${id}:${type}`,
      },
    ];
  }

  private async paymentAgreement(event: DomainEvent): Promise<NotificationIntent[]> {
    const p = event.payload;
    const requesterId = str(p, 'requesterId');
    const runnerId = str(p, 'runnerId');
    const role = str(p, 'actorRole');
    const assignmentId = str(p, 'assignmentId');
    if (!requesterId || !runnerId || !role || !assignmentId) return [];
    const fullyConfirmed = p.fullyConfirmed === true;
    if (!fullyConfirmed && p.termsChanged !== true) return [];
    const other = role === 'REQUESTER' ? runnerId : requesterId;
    return [
      {
        userId: other,
        template: fullyConfirmed ? 'payment_agreement.confirmed' : 'payment_agreement.updated',
        vars: await this.vars(p, {}),
        data: this.ids(p),
        dedupeKey: `agreement:${assignmentId}:${event.eventId}`,
      },
    ];
  }

  private verification(event: DomainEvent): NotificationIntent[] {
    const userId = str(event.payload, 'userId');
    if (!userId) return [];
    return [
      {
        userId,
        template: event.eventType,
        vars: {},
        data: { attemptId: str(event.payload, 'attemptId') ?? null },
        dedupeKey: `verification:${str(event.payload, 'attemptId') ?? event.eventId}:${event.eventType}`,
      },
    ];
  }

  private async message(p: Record<string, unknown>): Promise<NotificationIntent[]> {
    const recipientId = str(p, 'recipientId');
    const messageId = str(p, 'messageId');
    const senderId = str(p, 'senderId');
    if (!recipientId || !messageId || !senderId) return [];
    return [
      {
        userId: recipientId,
        template: 'message.new',
        vars: { ...(await this.vars(p, {})), senderName: await this.firstName(senderId) },
        data: { errandId: str(p, 'errandId') ?? null, conversationId: str(p, 'conversationId') ?? null },
        dedupeKey: `message:${messageId}`,
        conversationId: str(p, 'conversationId'),
      },
    ];
  }

  // ---- shared ----

  private async toRequester(
    p: Record<string, unknown>,
    template: string,
    dedupeKey: string,
    options: { runnerNameOf?: string; extraVars?: Record<string, string>; errandIdKey?: string },
  ): Promise<NotificationIntent[]> {
    const requesterId = str(p, 'requesterId');
    if (!requesterId) return [];
    return [
      {
        userId: requesterId,
        template,
        vars: { ...(await this.vars(p, { runnerNameOf: options.runnerNameOf })), ...options.extraVars },
        data: this.ids(p),
        dedupeKey,
      },
    ];
  }

  private async toRunner(p: Record<string, unknown>, template: string, dedupeKey: string): Promise<NotificationIntent[]> {
    const runnerId = str(p, 'runnerId');
    if (!runnerId) return [];
    return [{ userId: runnerId, template, vars: await this.vars(p, {}), data: this.ids(p), dedupeKey }];
  }

  private ids(p: Record<string, unknown>): Record<string, string | number | boolean | null> {
    return {
      errandId: str(p, 'errandId') ?? null,
      assignmentId: str(p, 'assignmentId') ?? null,
      offerId: str(p, 'offerId') ?? str(p, 'selectedOfferId') ?? null,
    };
  }

  private async vars(p: Record<string, unknown>, options: { runnerNameOf?: string; amount?: boolean }): Promise<Record<string, string>> {
    const errandId = str(p, 'errandId');
    const vars: Record<string, string> = {};
    if (errandId) vars.errandTitle = await this.errandTitle(errandId);
    const runnerId = options.runnerNameOf ? str(p, options.runnerNameOf) : undefined;
    if (runnerId) vars.runnerName = await this.firstName(runnerId);
    const amount = num(p, 'amountMinor') ?? num(p, 'agreedAmountMinor');
    if (options.amount && amount !== undefined) vars.amount = formatNaira(amount);
    return vars;
  }

  private async errandTitle(errandId: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ title: string }>>`SELECT title FROM errands WHERE id = ${errandId}::uuid`;
    return rows[0]?.title ?? 'your errand';
  }

  private async firstName(userId: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ first_name: string }>>`SELECT first_name FROM users WHERE id = ${userId}::uuid`;
    return rows[0]?.first_name ?? 'Someone';
  }

  private async runnerOf(errandId: string): Promise<string | undefined> {
    const rows = await this.prisma.$queryRaw<Array<{ runner_id: string }>>`
      SELECT runner_id::text FROM assignments
      WHERE errand_id = ${errandId}::uuid AND status IN ('ACCEPTED'::"AssignmentStatus", 'COMPLETED'::"AssignmentStatus") AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows[0]?.runner_id;
  }
}

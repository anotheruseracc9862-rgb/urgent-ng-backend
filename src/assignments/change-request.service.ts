import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType, Prisma, type ChangeRequest } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  CHANGE_REQUEST_NOT_ALLOWED,
  CHANGE_REQUEST_PENDING,
  FORBIDDEN,
  RESOURCE_NOT_FOUND,
  VALIDATION_ERROR,
} from '../common/constants/error-codes.js';
import { ErrandLocationRepository, type ErrandLocationType, type ErrandLocationWrite } from '../errands/errand-location.repository.js';
import { LocationPrivacyService } from '../errands/location-privacy.service.js';
import { isValidPoint } from '../errands/location-privacy.js';
import { OfferService } from '../offers/offer.service.js';
import type { ChangeRequestDto, CreateChangeRequestDto } from './change-request.dto.js';

/** Raised inside the lazy-expiry transaction: the request is pending and in time after all. */
class NotDue extends Error {}

const LIVE_ERRAND_STATUSES: readonly string[] = ['ACCEPTED', 'IN_PROGRESS'];

interface Parsed {
  amountMinor?: number;
  point?: { lat: number; lng: number };
  addressText?: string;
  landmark?: string;
  scheduledAt?: Date;
  note?: string;
}

export function toChangeRequestDto(row: ChangeRequest): ChangeRequestDto {
  return {
    id: row.id,
    assignmentId: row.assignmentId,
    requestedBy: row.requestedBy,
    type: row.type,
    payload: row.payload as Record<string, unknown>,
    status: row.status,
    respondedBy: row.respondedBy,
    respondedAt: row.respondedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * Change requests after acceptance (Backend PRD 15.6). Once the runner accepted, details and the
 * amount cannot change silently: one party proposes, the other accepts or rejects.
 *
 *  - one pending request per assignment (database partial unique index);
 *  - only while the errand is ACCEPTED or IN_PROGRESS, so location and time changes are blocked
 *    from pickup on;
 *  - it expires after CHANGE_REQUEST_EXPIRY_HOURS, or at pickup, whichever is first;
 *  - an accepted AMOUNT change updates the assignment, the offer and the agreement (clearing both
 *    confirmations); an accepted location or time change updates the errand and writes a version.
 */
@Injectable()
export class ChangeRequestService {
  private readonly logger = new Logger(ChangeRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly offers: OfferService,
    private readonly locations: ErrandLocationRepository,
    private readonly privacy: LocationPrivacyService,
  ) {}

  async create(userId: string, assignmentId: string, input: CreateChangeRequestDto): Promise<ChangeRequestDto> {
    const parsed = await this.parse(input);
    const hours = await this.config.get('CHANGE_REQUEST_EXPIRY_HOURS');
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const a = await this.lockLive(tx, assignmentId, userId);
        if (input.type === 'AMOUNT' && parsed.amountMinor === a.agreedAmountMinor) {
          throw DomainException.of(VALIDATION_ERROR, { message: 'That is already the agreed amount.', details: { field: 'payload.amountMinor' } });
        }
        if (input.type === 'TIME' && a.timeMode !== 'SCHEDULED') {
          throw DomainException.of(CHANGE_REQUEST_NOT_ALLOWED, { message: 'Only a scheduled errand has a time to change.' });
        }
        const pending = await tx.changeRequest.findFirst({ where: { assignmentId, status: 'PENDING' }, select: { id: true } });
        if (pending) {
          throw DomainException.of(CHANGE_REQUEST_PENDING, { details: { changeRequestId: pending.id } });
        }
        const now = await this.dbNow(tx);
        const created = await tx.changeRequest.create({
          data: {
            assignmentId,
            requestedBy: userId,
            type: input.type,
            payload: input.payload as Prisma.InputJsonObject,
            expiresAt: new Date(now.getTime() + hours * 3_600_000),
          },
        });
        await tx.executionEvent.create({
          data: {
            assignmentId,
            errandId: a.errandId,
            type: 'CHANGE_REQUESTED',
            actorId: userId,
            actorType: AuditActorType.USER,
            metadata: { changeRequestId: created.id, type: input.type } as Prisma.InputJsonObject,
          },
        });
        await this.publish(tx, 'change_request.created', created, a, userId, {});
        return created;
      });
      return toChangeRequestDto(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw DomainException.of(CHANGE_REQUEST_PENDING);
      }
      throw error;
    }
  }

  async list(userId: string, assignmentId: string): Promise<ChangeRequestDto[]> {
    const found = await this.prisma.assignment.findFirst({
      where: { id: assignmentId, OR: [{ requesterId: userId }, { runnerId: userId }] },
      select: { id: true },
    });
    if (!found) throw DomainException.of(RESOURCE_NOT_FOUND);
    const rows = await this.prisma.changeRequest.findMany({ where: { assignmentId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toChangeRequestDto);
  }

  /** The other party accepts. Applies the change in the same transaction. */
  async accept(userId: string, changeRequestId: string): Promise<ChangeRequestDto> {
    const pre = await this.requireOther(userId, changeRequestId);
    // Provider calls (reverse geocoding) happen before the transaction.
    const parsed = await this.parse({ type: pre.type, payload: pre.payload as Record<string, unknown> });
    let write: ErrandLocationWrite | undefined;
    if ((pre.type === 'PICKUP' || pre.type === 'DESTINATION') && parsed.point) {
      write = await this.privacy.prepare({
        errandId: pre.errandId,
        type: (pre.type === 'PICKUP' ? 'ERRAND_PICKUP' : 'ERRAND_DESTINATION') as ErrandLocationType,
        point: parsed.point,
        addressText: parsed.addressText,
        landmark: parsed.landmark,
        source: 'MAP_PIN',
      });
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const a = await this.lockLive(tx, pre.assignmentId, userId);
        const current = await this.lockRequest(tx, changeRequestId);
        if (current.status !== 'PENDING') {
          throw DomainException.of(CHANGE_REQUEST_NOT_ALLOWED, { message: 'This request was already answered.', details: { status: current.status } });
        }
        if (current.requestedBy === userId) {
          throw DomainException.of(FORBIDDEN, { message: 'The other party has to answer this request.' });
        }
        const now = await this.dbNow(tx);
        if (current.expiresAt.getTime() <= now.getTime()) {
          throw DomainException.of(CHANGE_REQUEST_NOT_ALLOWED, { message: 'This request has expired.', details: { reason: 'EXPIRED' } });
        }

        await this.apply(tx, current, parsed, write, a);

        const answered = await tx.changeRequest.update({
          where: { id: changeRequestId },
          data: { status: 'ACCEPTED', respondedBy: userId, respondedAt: now },
        });
        await tx.executionEvent.create({
          data: {
            assignmentId: a.id,
            errandId: a.errandId,
            type: 'CHANGE_ACCEPTED',
            actorId: userId,
            actorType: AuditActorType.USER,
            metadata: { changeRequestId, type: current.type } as Prisma.InputJsonObject,
          },
        });
        await this.publish(tx, 'change_request.accepted', answered, a, userId, {});
        return answered;
      });
      return toChangeRequestDto(row);
    } catch (error) {
      if (error instanceof DomainException && error.getCode() === CHANGE_REQUEST_NOT_ALLOWED && (error.getDetails() as { reason?: string } | undefined)?.reason === 'EXPIRED') {
        await this.expireOne(changeRequestId).catch(() => undefined);
      }
      throw error;
    }
  }

  async reject(userId: string, changeRequestId: string): Promise<ChangeRequestDto> {
    return this.answer(userId, changeRequestId, 'REJECTED', 'change_request.rejected', false);
  }

  /** The proposer withdraws their own pending request. */
  async cancel(userId: string, changeRequestId: string): Promise<ChangeRequestDto> {
    return this.answer(userId, changeRequestId, 'CANCELLED', 'change_request.cancelled', true);
  }

  /** The sweeper's batch (database clock). */
  async expireDue(limit = 100): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM change_requests
      WHERE status = 'PENDING'::"ChangeRequestStatus" AND deleted_at IS NULL AND expires_at <= clock_timestamp()
      ORDER BY expires_at
      LIMIT ${limit}
    `;
    let expired = 0;
    for (const { id } of due) {
      try {
        if (await this.expireOne(id)) expired += 1;
      } catch (error) {
        this.logger.error(`Could not expire change request ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return expired;
  }

  /**
   * Pickup ends the window for every kind of change (Backend PRD 15.6). Called in the pickup
   * transaction, with the assignment row already locked.
   */
  async expirePendingAtPickup(tx: Prisma.TransactionClient, assignmentId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE change_requests
      SET status = 'EXPIRED'::"ChangeRequestStatus", responded_at = NULL, updated_at = clock_timestamp()
      WHERE assignment_id = ${assignmentId}::uuid AND status = 'PENDING'::"ChangeRequestStatus" AND deleted_at IS NULL
      RETURNING id::text
    `;
    for (const { id } of rows) {
      await this.outbox.add(tx, {
        eventType: 'change_request.expired',
        aggregateType: 'change_request',
        aggregateId: id,
        payload: { changeRequestId: id, assignmentId, reason: 'PICKED_UP' },
      });
    }
  }

  // ---- internals ----

  private async expireOne(changeRequestId: string): Promise<boolean> {
    const found = await this.prisma.changeRequest.findFirst({ where: { id: changeRequestId }, select: { assignmentId: true } });
    if (!found) return false;
    try {
      await this.prisma.$transaction(async (tx) => {
        // Same order as everywhere: errand, assignment, request.
        const ids = await tx.$queryRaw<Array<{ errand_id: string }>>`
          SELECT errand_id::text FROM assignments WHERE id = ${found.assignmentId}::uuid
        `;
        if (ids[0]) {
          await tx.$queryRaw`SELECT id FROM errands WHERE id = ${ids[0].errand_id}::uuid FOR SHARE`;
        }
        const rows = await tx.$queryRaw<Array<{ id: string; requested_by: string }>>`
          UPDATE change_requests
          SET status = 'EXPIRED'::"ChangeRequestStatus", updated_at = clock_timestamp()
          WHERE id = ${changeRequestId}::uuid AND status = 'PENDING'::"ChangeRequestStatus"
            AND expires_at <= clock_timestamp() AND deleted_at IS NULL
          RETURNING id::text, requested_by::text
        `;
        if (rows.length === 0) throw new NotDue();
        await this.outbox.add(tx, {
          eventType: 'change_request.expired',
          aggregateType: 'change_request',
          aggregateId: changeRequestId,
          payload: { changeRequestId, assignmentId: found.assignmentId, reason: 'TIMEOUT' },
        });
      });
      return true;
    } catch (error) {
      if (error instanceof NotDue) return false;
      throw error;
    }
  }

  private async answer(
    userId: string,
    changeRequestId: string,
    status: 'REJECTED' | 'CANCELLED',
    eventType: string,
    byProposer: boolean,
  ): Promise<ChangeRequestDto> {
    const pre = await this.requireParty(userId, changeRequestId);
    const row = await this.prisma.$transaction(async (tx) => {
      const a = await this.lockLive(tx, pre.assignmentId, userId, { allowEnded: true });
      const current = await this.lockRequest(tx, changeRequestId);
      if (current.status !== 'PENDING') {
        throw DomainException.of(CHANGE_REQUEST_NOT_ALLOWED, { message: 'This request was already answered.', details: { status: current.status } });
      }
      const isProposer = current.requestedBy === userId;
      if (byProposer !== isProposer) {
        throw DomainException.of(FORBIDDEN, {
          message: byProposer ? 'Only the person who made the request can cancel it.' : 'The other party has to answer this request.',
        });
      }
      const now = await this.dbNow(tx);
      const answered = await tx.changeRequest.update({
        where: { id: changeRequestId },
        data: { status, respondedBy: userId, respondedAt: now },
      });
      await this.publish(tx, eventType, answered, a, userId, {});
      return answered;
    });
    return toChangeRequestDto(row);
  }

  /** Apply an accepted request to the assignment and errand (Backend PRD 15.6). */
  private async apply(
    tx: Prisma.TransactionClient,
    request: ChangeRequest,
    parsed: Parsed,
    write: ErrandLocationWrite | undefined,
    a: LiveAssignment,
  ): Promise<void> {
    switch (request.type) {
      case 'AMOUNT': {
        const amount = parsed.amountMinor!;
        await tx.assignment.update({ where: { id: a.id }, data: { agreedAmountMinor: BigInt(amount), version: { increment: 1 } } });
        // The agreed amount changed, so both confirmations no longer cover it.
        await tx.paymentAgreement.update({
          where: { assignmentId: a.id },
          data: { agreedAmountMinor: BigInt(amount), confirmedByRequesterAt: null, confirmedByRunnerAt: null },
        });
        await this.offers.recordAgreedAmountChange(tx, a.selectedOfferId, amount, request.requestedBy, request.requestedBy === a.requesterId ? a.runnerId : a.requesterId);
        return;
      }
      case 'PICKUP':
      case 'DESTINATION': {
        const before = await this.locations.findForErrand(tx, a.errandId);
        await this.snapshot(tx, a, request.type, {
          locations: before.map((location) => ({
            type: location.type,
            exact: location.exact,
            addressText: location.addressText,
            landmark: location.landmark,
            area: location.area,
          })),
        });
        await this.locations.upsert(tx, write!);
        await this.locations.refreshFeedPoint(tx, a.errandId);
        await this.bumpErrand(tx, a.errandId);
        return;
      }
      case 'TIME': {
        const row = await tx.errand.findUniqueOrThrow({ where: { id: a.errandId }, select: { scheduledAt: true } });
        await this.snapshot(tx, a, 'TIME', { scheduledAt: row.scheduledAt });
        await tx.$executeRaw`UPDATE errands SET scheduled_at = ${parsed.scheduledAt}::timestamptz WHERE id = ${a.errandId}::uuid`;
        await this.bumpErrand(tx, a.errandId);
        return;
      }
      case 'OTHER':
        return;
    }
  }

  private async snapshot(tx: Prisma.TransactionClient, a: LiveAssignment, field: string, snapshot: Record<string, unknown>): Promise<void> {
    await tx.errandVersion.create({
      data: {
        errandId: a.errandId,
        version: a.errandVersion,
        changedBy: a.requesterId,
        changedFields: [field],
        snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonObject,
      },
    });
  }

  private async bumpErrand(tx: Prisma.TransactionClient, errandId: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE errands SET version = version + 1, material_version = material_version + 1, updated_at = clock_timestamp()
      WHERE id = ${errandId}::uuid
    `;
  }

  /**
   * Lock the errand (shared) then the assignment, and require an ACCEPTED assignment on an errand
   * that is ACCEPTED or IN_PROGRESS. The caller must be one of the two parties.
   */
  private async lockLive(
    tx: Prisma.TransactionClient,
    assignmentId: string,
    userId: string,
    options: { allowEnded?: boolean } = {},
  ): Promise<LiveAssignment> {
    const ids = await tx.$queryRaw<Array<{ errand_id: string }>>`
      SELECT errand_id::text FROM assignments WHERE id = ${assignmentId}::uuid AND deleted_at IS NULL
    `;
    if (!ids[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
    const errands = await tx.$queryRaw<Array<{ status: string; version: number; time_mode: string | null }>>`
      SELECT status::text AS status, version, time_mode::text AS time_mode FROM errands
      WHERE id = ${ids[0].errand_id}::uuid FOR SHARE
    `;
    const rows = await tx.$queryRaw<
      Array<{ id: string; errand_id: string; requester_id: string; runner_id: string; selected_offer_id: string; status: string; amount: bigint }>
    >`
      SELECT id::text, errand_id::text, requester_id::text, runner_id::text, selected_offer_id::text, status::text AS status,
             agreed_amount_minor AS amount
      FROM assignments WHERE id = ${assignmentId}::uuid AND deleted_at IS NULL FOR UPDATE
    `;
    const row = rows[0];
    const errand = errands[0];
    if (!row || !errand || (row.requester_id !== userId && row.runner_id !== userId)) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (!options.allowEnded && (row.status !== 'ACCEPTED' || !LIVE_ERRAND_STATUSES.includes(errand.status))) {
      throw DomainException.of(CHANGE_REQUEST_NOT_ALLOWED, {
        message: 'Changes can only be requested while the errand is accepted or in progress.',
        details: { assignmentStatus: row.status, errandStatus: errand.status },
      });
    }
    return {
      id: row.id,
      errandId: row.errand_id,
      requesterId: row.requester_id,
      runnerId: row.runner_id,
      selectedOfferId: row.selected_offer_id,
      agreedAmountMinor: Number(row.amount),
      errandVersion: errand.version,
      timeMode: errand.time_mode,
    };
  }

  private async lockRequest(tx: Prisma.TransactionClient, changeRequestId: string): Promise<ChangeRequest> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM change_requests WHERE id = ${changeRequestId}::uuid AND deleted_at IS NULL FOR UPDATE
    `;
    const row = locked[0] ? await tx.changeRequest.findFirst({ where: { id: changeRequestId } }) : null;
    if (!row) throw DomainException.of(RESOURCE_NOT_FOUND);
    return row;
  }

  private async requireParty(userId: string, changeRequestId: string): Promise<{ assignmentId: string; errandId: string; type: ChangeRequest['type']; payload: unknown }> {
    const row = await this.prisma.changeRequest.findFirst({
      where: { id: changeRequestId, assignment: { OR: [{ requesterId: userId }, { runnerId: userId }] } },
      include: { assignment: { select: { errandId: true } } },
    });
    if (!row) throw DomainException.of(RESOURCE_NOT_FOUND);
    return { assignmentId: row.assignmentId, errandId: row.assignment.errandId, type: row.type, payload: row.payload };
  }

  private async requireOther(userId: string, changeRequestId: string) {
    const row = await this.requireParty(userId, changeRequestId);
    const full = await this.prisma.changeRequest.findFirstOrThrow({ where: { id: changeRequestId }, select: { requestedBy: true } });
    if (full.requestedBy === userId) {
      throw DomainException.of(FORBIDDEN, { message: 'The other party has to answer this request.' });
    }
    return row;
  }

  /** Validate a payload for its type. Throws VALIDATION_ERROR naming the field. */
  private async parse(input: { type: string; payload: Record<string, unknown> }): Promise<Parsed> {
    const bad = (field: string, message: string): never => {
      throw DomainException.of(VALIDATION_ERROR, { message, details: { field: `payload.${field}` } });
    };
    const payload = input.payload;
    switch (input.type) {
      case 'AMOUNT': {
        const amount = payload.amountMinor;
        const [min, max] = await Promise.all([this.config.get('OFFER_MIN_AMOUNT'), this.config.get('OFFER_MAX_AMOUNT')]);
        if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < min || amount > max) {
          bad('amountMinor', 'Enter an amount in kobo inside the allowed range.');
        }
        return { amountMinor: amount as number };
      }
      case 'PICKUP':
      case 'DESTINATION': {
        const point = payload.point as { lat?: unknown; lng?: unknown } | undefined;
        if (!point || typeof point.lat !== 'number' || typeof point.lng !== 'number' || !isValidPoint({ lat: point.lat, lng: point.lng })) {
          bad('point', 'Choose a valid point on the map.');
        }
        const text = (value: unknown, field: string): string | undefined => {
          if (value === undefined || value === null) return undefined;
          if (typeof value !== 'string' || value.length === 0 || value.length > 300) bad(field, 'Enter text up to 300 characters.');
          return value as string;
        };
        return {
          point: { lat: (point as { lat: number }).lat, lng: (point as { lng: number }).lng },
          addressText: text(payload.addressText, 'addressText'),
          landmark: text(payload.landmark, 'landmark'),
        };
      }
      case 'TIME': {
        const raw = payload.scheduledAt;
        const when = typeof raw === 'string' ? new Date(raw) : undefined;
        if (!when || Number.isNaN(when.getTime())) bad('scheduledAt', 'Enter a valid date and time.');
        if ((when as Date).getTime() <= Date.now()) bad('scheduledAt', 'The new time must be in the future.');
        return { scheduledAt: when as Date };
      }
      case 'OTHER': {
        const note = payload.note;
        if (typeof note !== 'string' || note.trim().length === 0 || note.length > 500) bad('note', 'Describe the change in up to 500 characters.');
        return { note: (note as string).trim() };
      }
      default:
        return bad('type', 'Unknown change type.');
    }
  }

  private async publish(
    tx: Prisma.TransactionClient,
    eventType: string,
    row: ChangeRequest,
    a: LiveAssignment,
    actorId: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.outbox.add(tx, {
      eventType,
      aggregateType: 'change_request',
      aggregateId: row.id,
      payload: {
        changeRequestId: row.id,
        assignmentId: a.id,
        errandId: a.errandId,
        requesterId: a.requesterId,
        runnerId: a.runnerId,
        type: row.type,
        status: row.status,
        requestedBy: row.requestedBy,
        ...extra,
      },
    });
    await this.audit.recordInTransaction(tx, {
      actorType: AuditActorType.USER,
      actorId,
      action: eventType,
      entityType: 'change_request',
      entityId: row.id,
      metadata: { assignmentId: a.id, errandId: a.errandId, type: row.type },
    });
  }

  private async dbNow(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return rows[0].now;
  }
}

interface LiveAssignment {
  id: string;
  errandId: string;
  requesterId: string;
  runnerId: string;
  selectedOfferId: string;
  agreedAmountMinor: number;
  errandVersion: number;
  timeMode: string | null;
}


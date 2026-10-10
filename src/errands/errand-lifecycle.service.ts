import { Injectable } from '@nestjs/common';
import { AuditActorType, type ErrandCancellationReason } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { lockRow } from '../database/lock-row.helper.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ERRAND_EXPIRED, ERRAND_INVALID_STATE, ERRAND_NOT_ELIGIBLE, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { computeExpiresAt } from './errand-expiry.js';
import { ErrandStateService } from './errand-state.service.js';
import { ErrandExpiryService } from './errand-expiry.service.js';
import { ErrandService } from './errand.service.js';
import { ErrandViewService } from './errand-view.service.js';
import type { CancelErrandDto, CreateErrandDto, ErrandDto } from './errand.dto.js';

/** Reasons a requester may give. The others are for runners, admins and the system. */
const REQUESTER_REASONS: readonly ErrandCancellationReason[] = ['REQUESTER_CANCELLED', 'DUPLICATE_ERRAND', 'SAFETY_CONCERN', 'NO_RUNNER_AVAILABLE', 'OTHER'];

/** Cancel, extend and duplicate (Backend PRD 11.4, 11.7). */
@Injectable()
export class ErrandLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly state: ErrandStateService,
    private readonly errands: ErrandService,
    private readonly view: ErrandViewService,
    private readonly expiry: ErrandExpiryService,
  ) {}

  /**
   * The requester cancels. The allowed stages are the rows of the state table: a draft, an open
   * errand, a pending or accepted assignment, and an errand in progress. From PICKED_UP on, the
   * errand can only become a dispute. The stage is kept in the event so reliability rules (Phase 9)
   * can score it.
   */
  async cancel(userId: string, errandId: string, dto: CancelErrandDto): Promise<ErrandDto> {
    if (!REQUESTER_REASONS.includes(dto.reason)) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'Choose one of the cancellation reasons offered.', details: { field: 'reason' } });
    }
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.errand.findFirst({ where: { id: errandId, requesterId: userId, deletedAt: null }, select: { status: true } });
      // From pickup on there is no plain cancel: it is a dispute or safety workflow, or simply completion.
      if (current?.status === 'PICKED_UP' || current?.status === 'DELIVERED') {
        throw DomainException.of(ERRAND_INVALID_STATE, {
          message:
            current.status === 'PICKED_UP'
              ? 'The item was already picked up. Open a dispute if there is a problem.'
              : 'The errand was delivered. Confirm completion, or open a dispute if there is a problem.',
          details: {
            from: current.status,
            to: 'CANCELLED',
            suggestedAction: current.status === 'PICKED_UP' ? 'OPEN_DISPUTE' : 'COMPLETE_OR_DISPUTE',
          },
        });
      }
      await this.state.transition(tx, {
        errandId,
        to: 'CANCELLED',
        ownerId: userId,
        actor: { type: 'REQUESTER', id: userId },
        cancellation: { reason: dto.reason, note: dto.note?.trim() || undefined },
        eventPayload: { stage: current?.status ?? null },
      });
    });
    return this.view.owner(this.prisma, errandId);
  }

  /**
   * Extend an open errand once, before it expires. The deadline is worked out again from now with
   * the same rule as at publishing. Offers stay valid.
   */
  async extend(userId: string, errandId: string): Promise<ErrandDto> {
    // An overdue errand is closed now, and the answer says it expired.
    const owned = await this.prisma.client.errand.findFirst({ where: { id: errandId, requesterId: userId }, select: { id: true } });
    if (owned && (await this.expiry.expireIfDue(errandId))) {
      throw DomainException.of(ERRAND_EXPIRED);
    }
    const [expiryHours, scheduledBufferMinutes, scheduledMaxOpenDays] = await Promise.all([
      this.config.get('ERRAND_EXPIRY_HOURS'),
      this.config.get('SCHEDULED_EXPIRY_BUFFER_MINUTES'),
      this.config.get('SCHEDULED_ERRAND_MAX_OPEN_DAYS'),
    ]);
    await this.prisma.$transaction(async (tx) => {
      const row = await lockRow<{
        requester_id: string;
        status: string;
        version: number;
        time_mode: 'ASAP' | 'SCHEDULED' | null;
        scheduled_at: Date | null;
        expires_at: Date | null;
        extended_at: Date | null;
        past_expiry: boolean;
        db_now: Date;
      }>(
        tx,
        'errands',
        errandId,
        `requester_id, status::text AS status, version, time_mode::text AS time_mode, scheduled_at, expires_at, extended_at,
         (expires_at IS NOT NULL AND expires_at <= clock_timestamp()) AS past_expiry, clock_timestamp() AS db_now`,
      );
      if (!row || row.requester_id !== userId) {
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }
      if (row.status !== 'OPEN') {
        throw DomainException.of(ERRAND_INVALID_STATE, { message: 'Only an open errand can be extended.', details: { status: row.status } });
      }
      if (row.past_expiry) {
        throw DomainException.of(ERRAND_EXPIRED);
      }
      if (row.extended_at) {
        throw DomainException.of(ERRAND_NOT_ELIGIBLE, { message: 'This errand was already extended once.', details: { reason: 'ALREADY_EXTENDED' } });
      }
      const expiresAt = computeExpiresAt(row.time_mode ?? 'ASAP', row.scheduled_at, row.db_now, { expiryHours, scheduledBufferMinutes, scheduledMaxOpenDays });
      if (!row.expires_at || expiresAt <= row.expires_at) {
        throw DomainException.of(ERRAND_NOT_ELIGIBLE, {
          message: 'This errand cannot stay open any longer, because of its scheduled time.',
          details: { reason: 'NOTHING_TO_EXTEND' },
        });
      }
      await tx.$executeRaw`
        UPDATE errands
        SET expires_at = ${expiresAt}::timestamptz, extended_at = ${row.db_now}::timestamptz, version = version + 1, updated_at = ${row.db_now}::timestamptz
        WHERE id = ${errandId}::uuid
      `;
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'errand.extended',
        entityType: 'errand',
        entityId: errandId,
        metadata: { expiresAt: expiresAt.toISOString() },
      });
      await this.outbox.add(tx, {
        eventType: 'errand.extended',
        aggregateType: 'errand',
        aggregateId: errandId,
        payload: { errandId, requesterId: userId, previousExpiresAt: row.expires_at, expiresAt },
      });
    });
    return this.view.owner(this.prisma, errandId);
  }

  /**
   * Copy an errand into a new draft (repost). The schedule is not copied (it is probably in the
   * past); an ASAP errand stays ASAP. Locations get a new approximate point, photos are shared.
   */
  async duplicate(userId: string, errandId: string): Promise<ErrandDto> {
    const source = await this.errands.getOwned(userId, errandId);
    const copyLocation = (location: ErrandDto['pickup']) =>
      location
        ? {
            point: location.exact,
            addressText: location.addressText ?? undefined,
            landmark: location.landmark ?? undefined,
            source: 'MAP_PIN' as const,
          }
        : undefined;
    const contact = (value: ErrandDto['pickupContact']) =>
      value ? { name: value.name ?? undefined, phone: value.phone ?? undefined } : undefined;

    const copy: CreateErrandDto = {
      categoryId: source.category.id,
      title: source.title,
      description: source.description,
      instructions: source.instructions ?? undefined,
      timeMode: source.timeMode === 'ASAP' ? 'ASAP' : undefined,
      suggestedBudgetMinor: source.suggestedBudgetMinor ?? undefined,
      itemSize: source.itemSize ?? undefined,
      itemValueMinor: source.itemValueMinor ?? undefined,
      pickup: copyLocation(source.pickup),
      destination: copyLocation(source.destination),
      pickupContact: contact(source.pickupContact),
      dropoffContact: contact(source.dropoffContact),
      photoMediaIds: source.photos.map((photo) => photo.mediaId),
    };
    return this.errands.create(userId, copy);
  }
}

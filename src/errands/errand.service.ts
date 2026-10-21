import { Inject, Injectable } from '@nestjs/common';
import { AuditActorType, type Category, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { PolicyService } from '../auth/policy.service.js';
import { lockRow } from '../database/lock-row.helper.js';
import { generateUuidV7 } from '../common/utils/uuid.helper.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ERRAND_INVALID_STATE, ERRAND_NOT_ELIGIBLE, FORBIDDEN, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { computeExpiresAt } from './errand-expiry.js';
import { ErrandStateService } from './errand-state.service.js';
import { ErrandExpiryService } from './errand-expiry.service.js';
import { ErrandLocationRepository, type ErrandLocationType, type ErrandLocationWrite } from './errand-location.repository.js';
import { LocationPrivacyService } from './location-privacy.service.js';
import { ErrandContactService } from './errand-contact.service.js';
import { ErrandPhotosService } from './errand-photos.service.js';
import { ErrandValidatorService } from './errand-validator.service.js';
import { ErrandViewService } from './errand-view.service.js';
import { OFFER_RECONFIRMATION_HOOK, type OfferReconfirmationHook } from './offer-reconfirmation.hook.js';
import type { CreateErrandDto, ErrandDto, ErrandLocationInputDto, PublishErrandDto, UpdateErrandDto } from './errand.dto.js';
import { resolveState, resolveLga } from '../geography/service-areas.js';

/** Statuses that count as a requester's "open errands" for the limit: published and not yet finished. */
export const LIVE_STATUSES = ['OPEN', 'RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED', 'DISPUTED'] as const;

export interface Requester {
  userId: string;
  phoneVerified: boolean;
  emailVerified: boolean;
}

/** Material fields (Backend PRD 11.5). Changing one flags every live offer for reconfirmation. */
const MATERIAL_FIELDS = ['categoryId', 'timeMode', 'scheduledAt', 'itemSize', 'itemValueMinor', 'pickup', 'destination'] as const;

type LocationKey = 'pickup' | 'destination';
const LOCATION_TYPE: Record<LocationKey, ErrandLocationType> = { pickup: 'ERRAND_PICKUP', destination: 'ERRAND_DESTINATION' };

const minor = (value: number | null | undefined): bigint | null | undefined => (value === undefined ? undefined : value === null ? null : BigInt(value));
const sameInstant = (a: Date | null, b: Date | null | undefined): boolean => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * Creating, editing and publishing errands (Backend PRD 11.1 to 11.5). Cancel, extend and
 * duplicate are in `ErrandLifecycleService`. Every status change goes through `ErrandStateService`.
 */
@Injectable()
export class ErrandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly policies: PolicyService,
    private readonly state: ErrandStateService,
    private readonly locations: ErrandLocationRepository,
    private readonly privacy: LocationPrivacyService,
    private readonly contacts: ErrandContactService,
    private readonly photos: ErrandPhotosService,
    private readonly validator: ErrandValidatorService,
    private readonly view: ErrandViewService,
    private readonly expiry: ErrandExpiryService,
    @Inject(OFFER_RECONFIRMATION_HOOK) private readonly reconfirmation: OfferReconfirmationHook,
  ) {}

  // ---- Read ----

  async getOwned(userId: string, errandId: string): Promise<ErrandDto> {
    const owned = await this.prisma.client.errand.findFirst({ where: { id: errandId, requesterId: userId }, select: { id: true } });
    if (!owned) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    // Lazy expiry: an open errand past its deadline is closed now, not at the next sweep.
    await this.expiry.expireIfDue(errandId);
    return this.view.owner(this.prisma, errandId);
  }

  // ---- Create ----

  async create(userId: string, dto: CreateErrandDto): Promise<ErrandDto> {
    const category = await this.requireCategory(dto.categoryId);
    this.assertServiceHasNoPickup(category, dto.pickup);
    this.validator.assertScheduleShape(dto.timeMode, dto.scheduledAt);
    await this.validator.assertNoProhibitedText(dto.title, dto.description, dto.instructions);
    if (dto.timeMode === 'SCHEDULED' && !dto.scheduledAt) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'A scheduled errand needs a time.', details: { field: 'scheduledAt' } });
    }
    // The id is chosen first: the approximate location is derived from it, and finding the area
    // calls the maps provider, which must not happen while a database transaction is open.
    const errandId = generateUuidV7();
    const places = await this.prepareLocations(errandId, { pickup: dto.pickup, destination: dto.destination });
    const draftLimit = await this.config.get('MAX_DRAFTS_PER_REQUESTER');

    await this.prisma.$transaction(async (tx) => {
      await this.lockRequester(tx, userId);
      const drafts = await tx.errand.count({ where: { requesterId: userId, status: 'DRAFT', deletedAt: null } });
      if (drafts >= draftLimit) {
        throw DomainException.of(ERRAND_NOT_ELIGIBLE, {
          message: `You can keep at most ${draftLimit} drafts. Publish or delete one first.`,
          details: { reason: 'DRAFT_LIMIT', limit: draftLimit },
        });
      }
      await tx.errand.create({
        data: {
          id: errandId,
          requesterId: userId,
          categoryId: dto.categoryId,
          title: dto.title.trim(),
          description: dto.description?.trim() ?? '',
          instructions: dto.instructions?.trim() || null,
          timeMode: dto.timeMode ?? null,
          priority: dto.timeMode === 'ASAP' ? 'URGENT' : 'STANDARD',
          scheduledAt: dto.timeMode === 'SCHEDULED' ? (dto.scheduledAt ?? null) : null,
          suggestedBudgetMinor: minor(dto.suggestedBudgetMinor) ?? null,
          itemSize: dto.itemSize ?? null,
          itemValueMinor: minor(dto.itemValueMinor) ?? null,
        },
      });
      for (const key of ['pickup', 'destination'] as const) {
        if (places[key]) await this.locations.upsert(tx, places[key]);
      }
      await this.locations.refreshFeedPoint(tx, errandId);
      if (dto.pickupContact) await this.contacts.save(tx, errandId, 'pickup', dto.pickupContact);
      if (dto.dropoffContact) await this.contacts.save(tx, errandId, 'dropoff', dto.dropoffContact);
      if (dto.photoMediaIds) await this.photos.set(tx, userId, errandId, dto.photoMediaIds);
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.USER,
        actorId: userId,
        action: 'errand.draft_created',
        entityType: 'errand',
        entityId: errandId,
      });
      await this.outbox.add(tx, {
        eventType: 'errand.created',
        aggregateType: 'errand',
        aggregateId: errandId,
        payload: { errandId, requesterId: userId, categoryId: dto.categoryId },
      });
    });
    return this.view.owner(this.prisma, errandId);
  }

  // ---- Edit (drafts and open errands) ----

  /**
   * Draft: any field changes freely. Open: a material change (Backend PRD 11.5) writes a version
   * snapshot, bumps `materialVersion`, flags offers and tells the runners; a non-material change
   * only notifies. After a runner is selected an edit is refused (changes go through a change request).
   */
  async update(userId: string, errandId: string, dto: UpdateErrandDto): Promise<ErrandDto> {
    if (dto.categoryId) {
      this.assertServiceHasNoPickup(await this.requireCategory(dto.categoryId), dto.pickup ?? undefined);
    } else if (dto.pickup) {
      const current = await this.prisma.client.errand.findFirst({ where: { id: errandId, requesterId: userId }, select: { category: true } });
      if (current) this.assertServiceHasNoPickup(current.category, dto.pickup);
    }
    this.validator.assertScheduleShape(dto.timeMode, dto.scheduledAt);
    const places = await this.prepareLocations(errandId, { pickup: dto.pickup ?? undefined, destination: dto.destination ?? undefined });

    await this.prisma.$transaction(async (tx) => {
      const head = await lockRow<{ requester_id: string; status: string; version: number }>(
        tx,
        'errands',
        errandId,
        'requester_id, status::text AS status, version',
      );
      if (!head || head.requester_id !== userId) {
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }
      if (head.status !== 'DRAFT' && head.status !== 'OPEN') {
        throw DomainException.of(ERRAND_INVALID_STATE, {
          message: 'This errand can no longer be edited. Ask for a change instead.',
          details: { status: head.status },
        });
      }
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== head.version) {
        throw DomainException.of(ERRAND_INVALID_STATE, {
          message: 'The errand changed. Reload it and try again.',
          details: { reason: 'VERSION_MISMATCH', version: head.version },
        });
      }
      await this.applyEdit(tx, userId, errandId, head.status as 'DRAFT' | 'OPEN', head.version, dto, places);
    });
    return this.view.owner(this.prisma, errandId);
  }

  private async applyEdit(
    tx: Prisma.TransactionClient,
    userId: string,
    errandId: string,
    status: 'DRAFT' | 'OPEN',
    version: number,
    dto: UpdateErrandDto,
    places: Partial<Record<LocationKey, ErrandLocationWrite>>,
  ): Promise<void> {
    const before = await this.view.findWithCategory(tx, errandId);
    const beforeLocations = await this.locations.findForErrand(tx, errandId);
    const locationOf = (key: LocationKey) => beforeLocations.find((location) => location.type === LOCATION_TYPE[key]);

    const timeMode = dto.timeMode ?? before.timeMode ?? null;
    let scheduledAt = dto.scheduledAt === undefined ? before.scheduledAt : dto.scheduledAt;
    if (timeMode === 'ASAP') scheduledAt = null;
    if (timeMode === 'SCHEDULED' && !scheduledAt && (dto.timeMode !== undefined || dto.scheduledAt !== undefined)) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'A scheduled errand needs a time.', details: { field: 'scheduledAt' } });
    }

    // Which fields really change (a field sent with its current value is not a change).
    const changed: string[] = [];
    const data: Prisma.ErrandUncheckedUpdateInput = {};
    const set = <K extends keyof Prisma.ErrandUncheckedUpdateInput>(field: string, key: K, value: Prisma.ErrandUncheckedUpdateInput[K], differs: boolean) => {
      if (differs) {
        changed.push(field);
        data[key] = value;
      }
    };
    if (dto.categoryId !== undefined) set('categoryId', 'categoryId', dto.categoryId, dto.categoryId !== before.categoryId);
    if (dto.title !== undefined) set('title', 'title', dto.title.trim(), dto.title.trim() !== before.title);
    if (dto.description !== undefined) set('description', 'description', dto.description.trim(), dto.description.trim() !== before.description);
    if (dto.instructions !== undefined) set('instructions', 'instructions', dto.instructions?.trim() || null, (dto.instructions?.trim() || null) !== before.instructions);
    if (dto.timeMode !== undefined || dto.scheduledAt !== undefined) {
      set('timeMode', 'timeMode', timeMode, timeMode !== before.timeMode);
      set('scheduledAt', 'scheduledAt', scheduledAt, !sameInstant(before.scheduledAt, scheduledAt));
      if (timeMode !== before.timeMode) data.priority = timeMode === 'ASAP' ? 'URGENT' : 'STANDARD';
    }
    if (dto.suggestedBudgetMinor !== undefined) {
      set('suggestedBudgetMinor', 'suggestedBudgetMinor', minor(dto.suggestedBudgetMinor), (dto.suggestedBudgetMinor ?? null) !== (before.suggestedBudgetMinor === null ? null : Number(before.suggestedBudgetMinor)));
    }
    if (dto.itemSize !== undefined) set('itemSize', 'itemSize', dto.itemSize, (dto.itemSize ?? null) !== before.itemSize);
    if (dto.itemValueMinor !== undefined) {
      set('itemValueMinor', 'itemValueMinor', minor(dto.itemValueMinor), (dto.itemValueMinor ?? null) !== (before.itemValueMinor === null ? null : Number(before.itemValueMinor)));
    }

    const locationChange: Partial<Record<LocationKey, 'SET' | 'CLEAR'>> = {};
    for (const key of ['pickup', 'destination'] as const) {
      const sent = dto[key];
      if (sent === undefined) continue;
      const current = locationOf(key);
      const prepared = places[key];
      const stateId = resolveState(prepared?.state)?.id ?? null;
      const lgaId = stateId ? resolveLga(stateId, prepared?.lga)?.id ?? null : null;
      if (sent === null) {
        if (current) locationChange[key] = 'CLEAR';
      } else if (!current || this.locationDiffers(current, sent) ||
        (current.stateId ?? null) !== stateId || (current.lgaId ?? null) !== lgaId) {
        // Saving the same pin must also confirm legacy/previously unverified geography.
        locationChange[key] = 'SET';
      }
      if (locationChange[key]) changed.push(key);
    }

    const sideEffects: string[] = [];
    if (dto.pickupContact !== undefined) sideEffects.push('pickupContact');
    if (dto.dropoffContact !== undefined) sideEffects.push('dropoffContact');
    if (dto.photoMediaIds !== undefined) sideEffects.push('photoMediaIds');
    if (changed.length === 0 && sideEffects.length === 0) {
      if (status === 'OPEN') {
        await this.validator.assertPublishable(tx, userId, errandId, await this.validator.dbNow(tx), { checkSchedule: false });
      }
      return;
    }

    // Material fields: snapshot the values as they are now, before anything is written.
    const materialChanged = changed.filter((field) => (MATERIAL_FIELDS as readonly string[]).includes(field));
    const material = status === 'OPEN' && materialChanged.length > 0;
    if (material) {
      await tx.errandVersion.create({
        data: {
          errandId,
          version,
          changedBy: userId,
          changedFields: materialChanged,
          snapshot: JSON.parse(JSON.stringify(this.snapshot(before, beforeLocations))) as Prisma.InputJsonObject,
        },
      });
    }

    // Writes.
    if (Object.keys(data).length > 0) {
      await tx.errand.update({ where: { id: errandId }, data });
    }
    for (const key of ['pickup', 'destination'] as const) {
      if (locationChange[key] === 'SET' && places[key]) await this.locations.upsert(tx, places[key]);
      if (locationChange[key] === 'CLEAR') await this.locations.remove(tx, errandId, LOCATION_TYPE[key]);
    }
    if (Object.keys(locationChange).length > 0) await this.locations.refreshFeedPoint(tx, errandId);
    if (dto.pickupContact !== undefined) await this.contacts.save(tx, errandId, 'pickup', dto.pickupContact);
    if (dto.dropoffContact !== undefined) await this.contacts.save(tx, errandId, 'dropoff', dto.dropoffContact);
    if (dto.photoMediaIds !== undefined) await this.photos.set(tx, userId, errandId, dto.photoMediaIds);

    // An open errand must still be complete after the edit.
    const now = await this.validator.dbNow(tx);
    if (status === 'OPEN') {
      const scheduleChanged = changed.includes('timeMode') || changed.includes('scheduledAt');
      await this.validator.assertPublishable(tx, userId, errandId, now, { checkSchedule: scheduleChanged });
      if (scheduleChanged) {
        await this.recomputeExpiry(tx, errandId, before.extendedAt ?? before.publishedAt ?? now);
      }
    } else if (changed.includes('title') || changed.includes('description') || changed.includes('instructions')) {
      // A draft may be incomplete, but a clearly prohibited item is refused as soon as it is typed.
      const after = await this.view.findWithCategory(tx, errandId);
      await this.validator.assertNoProhibitedText(after.title, after.description, after.instructions);
    }

    await tx.$executeRaw`
      UPDATE errands
      SET version = version + 1,
          material_version = material_version + ${material ? 1 : 0},
          updated_at = now()
      WHERE id = ${errandId}::uuid
    `;

    if (status === 'OPEN') {
      const flagged = material ? await this.reconfirmation.flagOffers(tx, errandId) : 0;
      await this.outbox.add(tx, {
        eventType: 'errand.updated',
        aggregateType: 'errand',
        aggregateId: errandId,
        payload: { errandId, requesterId: userId, material, changedFields: [...changed, ...sideEffects], offersFlagged: flagged },
      });
    }
    await this.audit.recordInTransaction(tx, {
      actorType: AuditActorType.USER,
      actorId: userId,
      action: material ? 'errand.edited_material' : 'errand.edited',
      entityType: 'errand',
      entityId: errandId,
      metadata: { status, changedFields: [...changed, ...sideEffects], material },
    });
  }

  /** A scheduled errand's deadline follows its start time (Backend PRD 11.4). */
  private async recomputeExpiry(tx: Prisma.TransactionClient, errandId: string, base: Date): Promise<void> {
    const errand = await tx.errand.findUniqueOrThrow({ where: { id: errandId } });
    const expiresAt = computeExpiresAt(errand.timeMode ?? 'ASAP', errand.scheduledAt, base, await this.expiryConfig());
    await tx.errand.update({ where: { id: errandId }, data: { expiresAt } });
  }

  private async expiryConfig() {
    const [expiryHours, scheduledBufferMinutes, scheduledMaxOpenDays] = await Promise.all([
      this.config.get('ERRAND_EXPIRY_HOURS'),
      this.config.get('SCHEDULED_EXPIRY_BUFFER_MINUTES'),
      this.config.get('SCHEDULED_ERRAND_MAX_OPEN_DAYS'),
    ]);
    return { expiryHours, scheduledBufferMinutes, scheduledMaxOpenDays };
  }

  // ---- Publish ----

  /**
   * Validates, then moves DRAFT to OPEN in one transaction. A second call on an errand that is
   * already open fails with ERRAND_INVALID_STATE; the route is also protected by an Idempotency-Key,
   * which replays the first answer instead.
   */
  async publish(requester: Requester, errandId: string, dto: PublishErrandDto): Promise<ErrandDto> {
    if (!requester.phoneVerified && !requester.emailVerified) {
      throw DomainException.of(FORBIDDEN, {
        message: 'Verify your phone number before posting an errand.',
        details: { reason: 'ACCOUNT_NOT_VERIFIED' },
      });
    }
    if (dto.prohibitedItemsConfirmed !== true) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Confirm that your errand has no prohibited items.',
        details: { field: 'prohibitedItemsConfirmed' },
      });
    }
    const [openLimit, expiryConfig, policyVersion] = await Promise.all([
      this.config.get('MAX_OPEN_ERRANDS_PER_REQUESTER'),
      this.expiryConfig(),
      this.prohibitedPolicyVersion(),
    ]);

    await this.prisma.$transaction(async (tx) => {
      await this.lockRequester(tx, requester.userId);
      const live = await tx.errand.count({ where: { requesterId: requester.userId, status: { in: [...LIVE_STATUSES] }, deletedAt: null } });
      if (live >= openLimit) {
        throw DomainException.of(ERRAND_NOT_ELIGIBLE, {
          message: `You can have at most ${openLimit} open errands at a time.`,
          details: { reason: 'OPEN_ERRAND_LIMIT', limit: openLimit },
        });
      }
      const now = await this.validator.dbNow(tx);
      const current = await tx.errand.findFirst({ where: { id: errandId, requesterId: requester.userId, deletedAt: null }, select: { status: true } });
      if (!current) {
        throw DomainException.of(RESOURCE_NOT_FOUND);
      }
      if (current.status !== 'DRAFT') {
        throw DomainException.of(ERRAND_INVALID_STATE, { message: 'Only a draft can be published.', details: { status: current.status } });
      }
      await this.validator.assertPublishable(tx, requester.userId, errandId, now, { checkSchedule: true });
      const { categoryId } = await tx.errand.findUniqueOrThrow({ where: { id: errandId }, select: { categoryId: true } });

      await this.state.transition(tx, {
        errandId,
        to: 'OPEN',
        expectedFrom: 'DRAFT',
        ownerId: requester.userId,
        actor: { type: 'REQUESTER', id: requester.userId },
        apply: async (client, locked) => {
          const errand = await client.errand.findUniqueOrThrow({ where: { id: errandId } });
          const timeMode = errand.timeMode!;
          await client.errand.update({
            where: { id: errandId },
            data: {
              priority: timeMode === 'ASAP' ? 'URGENT' : 'STANDARD',
              publishedAt: locked.db_now,
              expiresAt: computeExpiresAt(timeMode, errand.scheduledAt, locked.db_now, expiryConfig),
              prohibitedItemsConfirmedAt: locked.db_now,
              prohibitedPolicyVersion: policyVersion,
            },
          });
        },
        eventPayload: { categoryId },
      });
    });
    return this.view.owner(this.prisma, errandId);
  }

  private async prohibitedPolicyVersion(): Promise<string> {
    const current = await this.policies.current();
    return current.find((policy) => policy.type === 'PROHIBITED_ITEMS_POLICY')?.version ?? '1.0';
  }

  // ---- Helpers ----

  private async requireCategory(categoryId: string): Promise<Category> {
    const category = await this.prisma.client.category.findFirst({ where: { id: categoryId, active: true } });
    if (!category) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'Choose a valid category.', details: { field: 'categoryId' } });
    }
    return category;
  }

  /** A service is done at one address, so it takes no pickup. Publishing checks the same rule for stored locations. */
  private assertServiceHasNoPickup(category: Category, pickup: unknown): void {
    if (category.flow === 'SERVICE' && pickup) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'A service has one address. Send it as the destination.', details: { field: 'pickup' } });
    }
  }

  /** One writer at a time per requester, so the draft and open limits cannot be beaten by parallel calls. */
  private async lockRequester(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`errand-limits:${userId}`}))`;
  }

  private async prepareLocations(
    errandId: string,
    input: Partial<Record<LocationKey, ErrandLocationInputDto | undefined>>,
  ): Promise<Partial<Record<LocationKey, ErrandLocationWrite>>> {
    const out: Partial<Record<LocationKey, ErrandLocationWrite>> = {};
    for (const key of ['pickup', 'destination'] as const) {
      const sent = input[key];
      if (!sent) continue;
      out[key] = await this.privacy.prepare({
        errandId,
        type: LOCATION_TYPE[key],
        point: sent.point,
        addressText: sent.addressText?.trim() || null,
        landmark: sent.landmark?.trim() || null,
        source: sent.source ?? 'MAP_PIN',
      });
    }
    return out;
  }

  private locationDiffers(
    current: { exact: { lat: number; lng: number }; addressText: string | null; landmark: string | null },
    sent: ErrandLocationInputDto,
  ): boolean {
    return (
      Math.abs(current.exact.lat - sent.point.lat) > 1e-7 ||
      Math.abs(current.exact.lng - sent.point.lng) > 1e-7 ||
      (current.addressText ?? null) !== (sent.addressText?.trim() || null) ||
      (current.landmark ?? null) !== (sent.landmark?.trim() || null)
    );
  }

  /** The errand as it was, for disputes. No contacts (Backend PRD A.5). */
  private snapshot(errand: Prisma.ErrandGetPayload<{ include: { category: true } }>, locations: Awaited<ReturnType<ErrandLocationRepository['findForErrand']>>) {
    return {
      categoryId: errand.categoryId,
      title: errand.title,
      description: errand.description,
      instructions: errand.instructions,
      timeMode: errand.timeMode,
      scheduledAt: errand.scheduledAt,
      suggestedBudgetMinor: errand.suggestedBudgetMinor === null ? null : Number(errand.suggestedBudgetMinor),
      itemSize: errand.itemSize,
      itemValueMinor: errand.itemValueMinor === null ? null : Number(errand.itemValueMinor),
      expiresAt: errand.expiresAt,
      locations: locations.map((location) => ({
        type: location.type,
        exact: location.exact,
        addressText: location.addressText,
        landmark: location.landmark,
        area: location.area,
        lga: location.lga,
        state: location.state,
      })),
    };
  }
}

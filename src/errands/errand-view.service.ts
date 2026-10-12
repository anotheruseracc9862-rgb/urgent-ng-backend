import { Injectable } from '@nestjs/common';
import type { Category, Errand, Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import { ErrandLocationRepository } from './errand-location.repository.js';
import { LocationPrivacyService, type ParticipantLocationView } from './location-privacy.service.js';
import { ErrandContactService } from './errand-contact.service.js';
import { ErrandPhotosService } from './errand-photos.service.js';
import type { ErrandDto } from './errand.dto.js';

type Client = Prisma.TransactionClient | PrismaService;

export type ErrandWithCategory = Errand & { category: Category };

export const toNumber = (value: bigint | null): number | null => (value === null ? null : Number(value));

/** The errand as the assigned runner sees it. `pickup` and `destination` have no exact fields unless `accessLevel` is EXACT. */
export interface RunnerErrandView {
  id: string;
  status: Errand['status'];
  version: number;
  category: { id: string; key: string; name: string };
  title: string;
  description: string;
  instructions: string | null;
  priority: Errand['priority'];
  timeMode: Errand['timeMode'];
  scheduledAt: Date | null;
  itemSize: Errand['itemSize'];
  itemValueMinor: number | null;
  pickup: ReturnType<LocationPrivacyService['view']> | null;
  destination: ReturnType<LocationPrivacyService['view']> | null;
  pickupContact: { name: string | null; phone: string | null } | null;
  dropoffContact: { name: string | null; phone: string | null } | null;
  photos: Array<{ mediaId: string; position: number }>;
  expiresAt: Date | null;
  /** When a delivered errand completes by itself; null when none is running (or a report or dispute holds it). */
  autoCompleteAt: Date | null;
  accessLevel: 'APPROXIMATE' | 'EXACT';
}

/**
 * Builds what the requester sees of their own errand: everything, including exact locations and
 * contacts. Other readers get the views in the marketplace and (later) assignment modules.
 */
@Injectable()
export class ErrandViewService {
  constructor(
    private readonly locations: ErrandLocationRepository,
    private readonly privacy: LocationPrivacyService,
    private readonly contacts: ErrandContactService,
    private readonly photos: ErrandPhotosService,
  ) {}

  async findWithCategory(client: Client, errandId: string): Promise<ErrandWithCategory> {
    const errand = await client.errand.findFirst({ where: { id: errandId, deletedAt: null }, include: { category: true } });
    if (!errand) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return errand;
  }

  /**
   * What the assigned runner sees (Backend PRD 14.2, 14.3, 17.1). While the assignment is pending
   * only the approximate area and non-sensitive details are returned. Exact locations and contacts
   * are included only when `exact` is true, which the caller sets from the assignment status
   * (`ACCEPTED`). The runner is never given what the caller did not ask for here.
   */
  async forAssignedRunner(client: Client, errandId: string, exact: boolean): Promise<RunnerErrandView> {
    const errand = await this.findWithCategory(client, errandId);
    const [locations, contacts, photos] = await Promise.all([
      this.locations.findForErrand(client, errandId),
      exact ? this.contacts.read(client, errandId) : Promise.resolve({ pickup: null, dropoff: null }),
      this.photos.list(client, errandId),
    ]);
    const level = exact ? 'PARTICIPANT' : 'PUBLIC';
    const at = (type: 'ERRAND_PICKUP' | 'ERRAND_DESTINATION') => {
      const found = locations.find((location) => location.type === type);
      return found ? this.privacy.view(found, level) : null;
    };
    return {
      id: errand.id,
      status: errand.status,
      version: errand.version,
      category: { id: errand.category.id, key: errand.category.key, name: errand.category.name },
      title: errand.title,
      description: errand.description,
      instructions: errand.instructions,
      priority: errand.priority,
      timeMode: errand.timeMode,
      scheduledAt: errand.scheduledAt,
      itemSize: errand.itemSize,
      itemValueMinor: toNumber(errand.itemValueMinor),
      pickup: at('ERRAND_PICKUP'),
      destination: at('ERRAND_DESTINATION'),
      pickupContact: contacts.pickup,
      dropoffContact: contacts.dropoff,
      photos,
      expiresAt: errand.expiresAt,
      autoCompleteAt: errand.autoCompleteAt,
      accessLevel: exact ? 'EXACT' : 'APPROXIMATE',
    };
  }

  async owner(client: Client, errandId: string): Promise<ErrandDto> {
    const errand = await this.findWithCategory(client, errandId);
    const [locations, contacts, photos] = await Promise.all([
      this.locations.findForErrand(client, errandId),
      this.contacts.read(client, errandId),
      this.photos.list(client, errandId),
    ]);
    const at = (type: 'ERRAND_PICKUP' | 'ERRAND_DESTINATION'): ParticipantLocationView | null => {
      const found = locations.find((location) => location.type === type);
      return found ? this.privacy.toParticipant(found) : null;
    };
    return {
      id: errand.id,
      status: errand.status,
      version: errand.version,
      category: { id: errand.category.id, key: errand.category.key, name: errand.category.name },
      title: errand.title,
      description: errand.description,
      instructions: errand.instructions,
      priority: errand.priority,
      timeMode: errand.timeMode,
      scheduledAt: errand.scheduledAt,
      suggestedBudgetMinor: toNumber(errand.suggestedBudgetMinor),
      itemSize: errand.itemSize,
      itemValueMinor: toNumber(errand.itemValueMinor),
      pickup: at('ERRAND_PICKUP'),
      destination: at('ERRAND_DESTINATION'),
      pickupContact: contacts.pickup,
      dropoffContact: contacts.dropoff,
      photos,
      offerCount: errand.offerCount,
      publishedAt: errand.publishedAt,
      expiresAt: errand.expiresAt,
      autoCompleteAt: errand.autoCompleteAt,
      extended: errand.extendedAt !== null,
      cancelledAt: errand.cancelledAt,
      cancellationReason: errand.cancellationReason,
      createdAt: errand.createdAt,
      updatedAt: errand.updatedAt,
    };
  }
}

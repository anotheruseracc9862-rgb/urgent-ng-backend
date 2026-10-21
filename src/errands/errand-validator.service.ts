import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { ERRAND_NOT_ELIGIBLE, SCHEDULE_OUT_OF_RANGE, VALIDATION_ERROR } from '../common/constants/error-codes.js';
import { isScheduleInRange } from './errand-expiry.js';
import { ErrandLocationRepository } from './errand-location.repository.js';
import { ErrandPhotosService } from './errand-photos.service.js';
import { ProhibitedItemsService } from './prohibited-items.service.js';
import { ErrandViewService } from './errand-view.service.js';
import { GeographyService } from '../geography/geography.service.js';

type Client = Prisma.TransactionClient | PrismaService;

export interface Problem {
  field: string;
  code: 'REQUIRED' | 'NOT_ALLOWED';
}

/**
 * The rules a complete, publishable errand must meet (Backend PRD 11.3). Used when publishing and
 * again after an edit of an open errand, so an open errand can never be edited into an incomplete one.
 */
@Injectable()
export class ErrandValidatorService {
  constructor(
    private readonly config: BusinessConfigService,
    private readonly locations: ErrandLocationRepository,
    private readonly photos: ErrandPhotosService,
    private readonly prohibited: ProhibitedItemsService,
    private readonly view: ErrandViewService,
    private readonly geography: GeographyService,
  ) {}

  /** The database clock, so business rules and the database agree on "now". */
  async dbNow(client: Client): Promise<Date> {
    const rows = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return rows[0].now;
  }

  /** `timeMode` and `scheduledAt` must agree. Safe to call on a draft. */
  assertScheduleShape(timeMode: 'ASAP' | 'SCHEDULED' | null | undefined, scheduledAt: Date | null | undefined): void {
    if (timeMode === 'SCHEDULED' && scheduledAt !== undefined && scheduledAt === null) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'A scheduled errand needs a time.', details: { field: 'scheduledAt' } });
    }
    if (timeMode === 'ASAP' && scheduledAt) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'An ASAP errand has no scheduled time.', details: { field: 'scheduledAt' } });
    }
  }

  /** At least `SCHEDULE_MIN_LEAD_HOURS` and at most `SCHEDULE_MAX_DAYS_AHEAD` days from now. */
  async assertScheduleInRange(scheduledAt: Date, now: Date): Promise<void> {
    const [minLeadHours, maxDaysAhead] = await Promise.all([
      this.config.get('SCHEDULE_MIN_LEAD_HOURS'),
      this.config.get('SCHEDULE_MAX_DAYS_AHEAD'),
    ]);
    if (!isScheduleInRange(scheduledAt, now, { minLeadHours, maxDaysAhead })) {
      throw DomainException.of(SCHEDULE_OUT_OF_RANGE, {
        message: `Schedule the errand between ${minLeadHours} hour(s) and ${maxDaysAhead} day(s) from now.`,
        details: { field: 'scheduledAt', minLeadHours, maxDaysAhead },
      });
    }
  }

  /** Blocks text that names a prohibited item (Backend PRD 11.9). */
  async assertNoProhibitedText(...texts: Array<string | null | undefined>): Promise<void> {
    const matches = await this.prohibited.find(...texts);
    if (matches.length > 0) {
      throw DomainException.of(ERRAND_NOT_ELIGIBLE, {
        message: 'This errand mentions an item that is not allowed on Urgent.ng.',
        details: { reason: 'PROHIBITED_ITEM', keywords: [...new Set(matches.map((match) => match.keyword))], policyVersion: matches[0].policyVersion },
      });
    }
  }

  /**
   * Everything an OPEN errand needs. Throws ERRAND_NOT_ELIGIBLE listing what is missing.
   * `checkSchedule` is off for edits that do not touch the schedule: a scheduled errand that is
   * about to start must stay editable.
   */
  async assertPublishable(client: Client, userId: string, errandId: string, now: Date, options: { checkSchedule: boolean }): Promise<void> {
    const errand = await this.view.findWithCategory(client, errandId);
    const locations = await this.locations.findForErrand(client, errandId);
    const problems: Problem[] = [];
    const missing = (field: string) => problems.push({ field, code: 'REQUIRED' });

    if (!errand.title.trim()) missing('title');
    if (!errand.description.trim()) missing('description');
    if (!errand.category.active) problems.push({ field: 'categoryId', code: 'NOT_ALLOWED' });

    const has = (type: string) => locations.some((location) => location.type === type);
    if (errand.category.requiresPickup && !has('ERRAND_PICKUP')) missing('pickup');
    if (errand.category.requiresDestination && !has('ERRAND_DESTINATION')) missing('destination');
    if (errand.category.flow === 'SERVICE' && has('ERRAND_PICKUP')) problems.push({ field: 'pickup', code: 'NOT_ALLOWED' });
    if (locations.length === 0 && !problems.some((problem) => problem.field === 'pickup' || problem.field === 'destination')) {
      missing('pickup');
    }

    if (!errand.timeMode) missing('timeMode');
    if (errand.timeMode === 'SCHEDULED' && !errand.scheduledAt) missing('scheduledAt');

    if (problems.length > 0) {
      throw DomainException.of(ERRAND_NOT_ELIGIBLE, {
        message: 'This errand is not complete yet.',
        details: { reason: 'INCOMPLETE', problems },
      });
    }
    if (options.checkSchedule && errand.timeMode === 'SCHEDULED' && errand.scheduledAt) {
      await this.assertScheduleInRange(errand.scheduledAt, now);
    }
    await this.geography.assertPublishable(locations);
    await this.assertNoProhibitedText(errand.title, errand.description, errand.instructions);
    await this.photos.assertAllReady(client, userId, errandId);
  }
}

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { UserStatsService } from '../ratings/user-stats.service.js';
import type { RequesterOfferSummaryDto } from './requester-offers.dto.js';

/**
 * Every offer on the requester's errands, newest first, so offers are not read one errand at a time. The runner is shown
 * by first name and public rating only, as on an errand's own offer list.
 */
@Injectable()
export class RequesterOffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cursors: CursorService,
    private readonly stats: UserStatsService,
  ) {}

  async list(
    requesterId: string,
    options: { status?: RequesterOfferSummaryDto['status']; cursor?: string; limit?: number },
  ): Promise<Paginated<RequesterOfferSummaryDto>> {
    const limit = options.limit ?? 20;
    const cursor = options.cursor ? this.cursors.decode(options.cursor) : undefined;
    const where: Prisma.OfferWhereInput = {
      requesterId,
      deletedAt: null,
      ...(options.status ? { status: options.status as Prisma.OfferWhereInput['status'] } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt as Date } },
              { createdAt: cursor.createdAt as Date, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.client.offer.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        errand: { select: { title: true, status: true, category: { select: { flow: true } } } },
        runner: { select: { firstName: true } },
      },
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const stats = await this.stats.getMany([...new Set(page.map((offer) => offer.runnerId))]);

    return new Paginated(
      page.map((offer) => ({
        id: offer.id,
        errandId: offer.errandId,
        status: offer.status,
        awaitingParty: offer.awaitingParty,
        amountMinor: Number(offer.amountMinor),
        durationMinutes: offer.durationMinutes,
        needsReconfirmation: offer.needsReconfirmation,
        version: offer.version,
        closeReason: offer.closeReason,
        errandTitle: offer.errand.title,
        errandStatus: offer.errand.status,
        categoryFlow: offer.errand.category.flow,
        runnerFirstName: offer.runner.firstName,
        runnerRating: stats.get(offer.runnerId)?.runner.average ?? null,
        runnerCompletedErrands: stats.get(offer.runnerId)?.completedAsRunner ?? 0,
        createdAt: offer.createdAt,
      })),
      {
        hasNextPage,
        ...(hasNextPage && last ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) } : {}),
      },
    );
  }
}

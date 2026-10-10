import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import type { RunnerOfferSummaryDto } from './runner-offers.dto.js';

/** The runner's own offers, newest first (Backend PRD 30.2). Only the area of an errand is shown, never exact data. */
@Injectable()
export class RunnerOffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cursors: CursorService,
  ) {}

  async list(
    runnerId: string,
    options: { status?: RunnerOfferSummaryDto['status']; cursor?: string; limit?: number },
  ): Promise<Paginated<RunnerOfferSummaryDto>> {
    const limit = options.limit ?? 20;
    const cursor = options.cursor ? this.cursors.decode(options.cursor) : undefined;
    const where: Prisma.OfferWhereInput = {
      runnerId,
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
        errand: { select: { title: true, status: true, locations: { where: { deletedAt: null }, select: { type: true, area: true } } } },
      },
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

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
        pickupArea: offer.errand.locations.find((l) => l.type === 'ERRAND_PICKUP')?.area ?? null,
        destinationArea: offer.errand.locations.find((l) => l.type === 'ERRAND_DESTINATION')?.area ?? null,
        createdAt: offer.createdAt,
      })),
      {
        hasNextPage,
        ...(hasNextPage && last ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) } : {}),
      },
    );
  }
}

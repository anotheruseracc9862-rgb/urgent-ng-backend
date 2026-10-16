import { Injectable } from '@nestjs/common';
import type { Notification, NotificationCategory, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { CursorService } from '../common/pagination/cursor.service.js';
import { Paginated } from '../common/pagination/paginated.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import type { NotificationDto, NotificationListQueryDto } from './notification.dto.js';

const toDto = (row: Notification): NotificationDto => ({
  id: row.id,
  category: row.category,
  type: row.type,
  title: row.title,
  body: row.body,
  data: row.data as Record<string, unknown>,
  readAt: row.readAt,
  createdAt: row.createdAt,
});

/** The signed-in user's own notification list. Nobody else's row is ever visible. */
@Injectable()
export class NotificationQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cursors: CursorService,
  ) {}

  async list(
    userId: string,
    options: NotificationListQueryDto,
  ): Promise<Paginated<NotificationDto>> {
    const limit = options.limit ?? 20;
    const cursor = options.cursor ? this.cursors.decode(options.cursor) : undefined;
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(options.unread ? { readAt: null } : {}),
      ...(options.category ? { category: options.category } : {}),
      ...(options.topic ? {
        AND: [{
          OR: (options.topic === 'OFFERS'
            ? ['offer.']
            : ['assignment.', 'execution.', 'errand.', 'change_request.', 'payment_agreement.', 'no_show.'])
            .map((prefix) => ({ type: { startsWith: prefix } })),
          ...(options.topic === 'PROGRESS' ? { NOT: { type: 'errand.nearby' } } : {}),
        }],
      } : {}),
      ...(cursor
        ? { OR: [{ createdAt: { lt: cursor.createdAt as Date } }, { createdAt: cursor.createdAt as Date, id: { lt: cursor.id } }] }
        : {}),
    };
    const rows = await this.prisma.client.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return new Paginated(page.map(toDto), {
      hasNextPage,
      ...(hasNextPage && last ? { nextCursor: this.cursors.encode({ sort: last.createdAt.toISOString(), createdAt: last.createdAt, id: last.id }) } : {}),
    });
  }

  unreadCount(userId: string, category?: NotificationCategory): Promise<number> {
    return this.prisma.client.notification.count({ where: { userId, readAt: null, ...(category ? { category } : {}) } });
  }

  async markRead(userId: string, id: string): Promise<NotificationDto> {
    const row = await this.prisma.client.notification.findFirst({ where: { id, userId } });
    if (!row) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    if (row.readAt) {
      return toDto(row);
    }
    const updated = await this.prisma.client.notification.update({ where: { id }, data: { readAt: new Date() } });
    return toDto(updated);
  }

  /** Returns how many were marked. */
  async readAll(userId: string): Promise<number> {
    const result = await this.prisma.client.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return result.count;
  }
}

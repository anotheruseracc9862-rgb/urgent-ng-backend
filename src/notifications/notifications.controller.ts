import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { NotificationQueryService } from './notification-query.service.js';
import { NotificationDto, NotificationListQueryDto, UnreadCountDto, UnreadCountQueryDto } from './notification.dto.js';

/** The in-app notification list (Backend PRD 19, 30.8). */
@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationQueryService) {}

  @Get()
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(NotificationDto, { isArray: true })
  @ApiErrors(400)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: NotificationListQueryDto) {
    return this.notifications.list(user.userId, query);
  }

  @Get('unread-count')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(UnreadCountDto)
  async unread(@CurrentUser() user: AuthenticatedUser, @Query() query: UnreadCountQueryDto): Promise<UnreadCountDto> {
    return { count: await this.notifications.unreadCount(user.userId, query.category) };
  }

  @Post('read-all')
  @HttpCode(200)
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(UnreadCountDto)
  async readAll(@CurrentUser() user: AuthenticatedUser): Promise<UnreadCountDto> {
    return { count: await this.notifications.readAll(user.userId) };
  }

  @Post(':id/read')
  @HttpCode(200)
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(NotificationDto)
  @ApiErrors(404)
  read(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.userId, id);
  }
}

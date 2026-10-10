import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth, RequireNoRestriction } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { ConversationService } from './conversation.service.js';
import { MessageService } from './message.service.js';
import { ConversationDto, ConversationListQueryDto, MarkReadDto, MarkedDto, MessageDto, MessageListQueryDto, MuteStateDto, SendMessageDto } from './messaging.dto.js';

/** Conversations and messages (Backend PRD 18, 30.7). Only the two parties of a conversation reach it. */
@ApiTags('Messaging')
@Controller()
export class MessagingController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
  ) {}

  @Get('conversations')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ConversationDto, { isArray: true })
  @ApiErrors(400)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ConversationListQueryDto) {
    return this.conversations.list(user.userId, query);
  }

  @Get('conversations/:id')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ConversationDto)
  @ApiErrors(404)
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.get(user.userId, id);
  }

  @Get('conversations/:id/messages')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(MessageDto, { isArray: true })
  @ApiErrors(400, 404)
  messagesOf(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Query() query: MessageListQueryDto) {
    return this.messages.list(user.userId, id, query);
  }

  @Post('conversations/:id/messages')
  @ConsumerAuth()
  @RequireNoRestriction('MESSAGING')
  @ApiConsumerAuth()
  @ApiEnveloped(MessageDto, { status: 201 })
  @ApiErrors(400, 403, 404, 409)
  send(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto) {
    return this.messages.send(user.userId, id, dto);
  }

  @Post('conversations/:id/read')
  @HttpCode(200)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(MarkedDto)
  @ApiErrors(404)
  async read(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkReadDto) {
    return { marked: await this.messages.markRead(user.userId, id, dto.upToMessageId) };
  }

  @Post('conversations/:id/mute')
  @HttpCode(200)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(MuteStateDto)
  @ApiErrors(404)
  async mute(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.conversations.setMuted(user.userId, id, true);
    return { muted: true };
  }

  @Post('conversations/:id/unmute')
  @HttpCode(200)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(MuteStateDto)
  @ApiErrors(404)
  async unmute(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.conversations.setMuted(user.userId, id, false);
    return { muted: false };
  }

  @Delete('messages/:id')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(MessageDto)
  @ApiErrors(404)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.messages.remove(user.userId, id);
  }
}

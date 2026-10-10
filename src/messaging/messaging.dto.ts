import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination/pagination.dto.js';

export const MAX_MESSAGE_LENGTH = 2000;

export class SendMessageDto {
  @ApiProperty({ enum: ['TEXT', 'IMAGE'] })
  @IsIn(['TEXT', 'IMAGE'])
  type!: 'TEXT' | 'IMAGE';

  @ApiPropertyOptional({ description: `Required for TEXT, up to ${MAX_MESSAGE_LENGTH} characters.` })
  @ValidateIf((o: SendMessageDto) => o.type === 'TEXT')
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_LENGTH)
  body?: string;

  @ApiPropertyOptional({ description: 'Required for IMAGE: a READY upload of purpose CHAT_IMAGE owned by the sender. One image per message.' })
  @ValidateIf((o: SendMessageDto) => o.type === 'IMAGE')
  @IsUUID()
  mediaId?: string;

  @ApiPropertyOptional({ description: 'A client-chosen id. Sending the same id again returns the first message instead of a second one.' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  clientMessageId?: string;
}

export class MarkReadDto {
  @ApiPropertyOptional({ description: 'Mark messages up to and including this one. Default: everything received.' })
  @IsOptional()
  @IsUUID()
  upToMessageId?: string;
}

export class MessageListQueryDto extends PaginationQueryDto {}

export class ConversationListQueryDto extends PaginationQueryDto {}

export class MessageDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  conversationId!: string;

  @ApiProperty()
  senderId!: string;

  @ApiProperty({ enum: ['TEXT', 'IMAGE', 'SYSTEM'] })
  type!: string;

  @ApiProperty({ nullable: true, description: 'Null for a removed message.' })
  body!: string | null;

  @ApiProperty({ nullable: true, description: 'Null for a removed message.' })
  mediaId!: string | null;

  @ApiProperty({ enum: ['SENT', 'DELIVERED', 'READ', 'REMOVED'] })
  status!: string;

  @ApiProperty({ nullable: true, description: 'Only on your own messages.' })
  clientMessageId!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  deliveredAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  readAt!: Date | null;

  @ApiProperty({ type: Date })
  createdAt!: Date;
}

export class ConversationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  errandId!: string;

  @ApiProperty()
  errandTitle!: string;

  @ApiProperty({ type: Object, description: 'The other person: { userId, firstName, photoMediaId }.' })
  counterpart!: { userId: string; firstName: string; photoMediaId: string | null };

  @ApiProperty({ type: Date, nullable: true })
  lastMessageAt!: Date | null;

  @ApiProperty()
  unreadCount!: number;

  @ApiProperty()
  muted!: boolean;

  @ApiProperty({ description: 'Whether this user can send a message now.' })
  canSend!: boolean;

  @ApiProperty({ nullable: true, enum: ['BLOCKED', 'ERRAND_ENDED', 'NO_ACTIVE_OFFER', 'COMPLETION_WINDOW_ENDED'] })
  readOnlyReason!: string | null;

  @ApiProperty({ type: Date })
  createdAt!: Date;
}

export class MarkedDto {
  @ApiProperty({ description: 'How many received messages were marked as read.' })
  marked!: number;
}

export class MuteStateDto {
  @ApiProperty()
  muted!: boolean;
}

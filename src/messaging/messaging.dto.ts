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

/** Tabs of the conversation list, by the state of the errand the conversation belongs to. */
export const CONVERSATION_FILTERS = ['ALL', 'ACTIVE', 'OFFERS', 'CLOSED'] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

export class ConversationListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: CONVERSATION_FILTERS,
    default: 'ALL',
    description:
      'ACTIVE: a runner is selected through delivery or the errand is disputed. OFFERS: the errand is still open. CLOSED: completed, cancelled or expired.',
  })
  @IsOptional()
  @IsIn(CONVERSATION_FILTERS as unknown as string[])
  filter?: ConversationFilter;

  @ApiPropertyOptional({ description: 'Search the errand title or the name of the other person.', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;
}

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

export class ConversationCounterpartDto {
  @ApiProperty()
  userId!: string;
  @ApiProperty()
  firstName!: string;
  @ApiProperty({ nullable: true, type: String })
  lastName!: string | null;
  @ApiProperty({ nullable: true, type: String })
  photoMediaId!: string | null;
  @ApiProperty({ enum: ['REQUESTER', 'RUNNER'], description: "The other person's side of this errand." })
  role!: 'REQUESTER' | 'RUNNER';
  @ApiProperty({ nullable: true, type: Number, description: 'Null until enough ratings are published to show an average.' })
  rating!: number | null;
  @ApiProperty()
  ratingCount!: number;
  @ApiProperty({ description: 'The other person is a runner with an active Runner Pro entitlement right now.' })
  isPro!: boolean;
}

export class ConversationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  errandId!: string;

  @ApiProperty()
  errandTitle!: string;

  @ApiProperty({ type: ConversationCounterpartDto, description: 'The other person.' })
  counterpart!: ConversationCounterpartDto;

  @ApiProperty({ nullable: true, type: String, description: 'The latest message that is not removed: its text, or "Photo". Null when there is none.' })
  lastMessagePreview!: string | null;

  @ApiProperty({ description: 'Where the errand is now, as the errand status.' })
  errandStatus!: string;

  @ApiProperty({ nullable: true, type: Number, description: 'Agreed amount in kobo once a runner is selected, otherwise the runner\'s latest offer. Null with neither.' })
  amountMinor!: number | null;

  @ApiProperty({ enum: ['AGREED', 'OFFER'], nullable: true, type: String })
  amountKind!: 'AGREED' | 'OFFER' | null;

  @ApiProperty({ nullable: true, type: String, description: 'Approximate area only.' })
  pickupArea!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'Approximate area only.' })
  destinationArea!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'The assignment for this conversation, from selection onward.' })
  assignmentId!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  lastMessageAt!: Date | null;

  @ApiProperty()
  unreadCount!: number;

  @ApiProperty()
  muted!: boolean;

  @ApiProperty({ description: 'Whether this user can send a message now.' })
  canSend!: boolean;

  @ApiProperty({ nullable: true, enum: ['BLOCKED', 'ERRAND_ENDED', 'NO_ACTIVE_OFFER', 'NOT_ASSIGNED', 'COMPLETION_WINDOW_ENDED'] })
  readOnlyReason!: string | null;

  @ApiProperty({ type: Date, nullable: true, description: 'When chat closes, once the errand is completed. Null before that.' })
  chatClosesAt!: Date | null;

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

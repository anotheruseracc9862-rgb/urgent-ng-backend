import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsIn, IsOptional } from 'class-validator';
import { NotificationCategory } from '@prisma/client';
import { Transform } from 'class-transformer';
import { PaginationQueryDto } from '../common/pagination/pagination.dto.js';

export class NotificationListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Only notifications not yet read.' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unread?: boolean;

  @ApiPropertyOptional({
    enum: NotificationCategory,
    description: 'Only one category: MARKETPLACE (offers and errands), TRANSACTIONAL (progress and account), MESSAGING, SAFETY.',
  })
  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;

  @ApiPropertyOptional({
    enum: ['OFFERS', 'PROGRESS'],
    description: 'OFFERS includes offer negotiations. PROGRESS includes assignment, execution and errand lifecycle updates, not nearby discovery alerts.',
  })
  @IsOptional()
  @IsIn(['OFFERS', 'PROGRESS'])
  topic?: 'OFFERS' | 'PROGRESS';
}

export class UnreadCountQueryDto {
  @ApiPropertyOptional({ enum: NotificationCategory })
  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;
}

export class NotificationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ['TRANSACTIONAL', 'SAFETY', 'MARKETPLACE', 'MESSAGING', 'MARKETING'] })
  category!: string;

  @ApiProperty({ description: 'The template key, for example offer.new.' })
  type!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ type: Object, description: 'Entity ids for the deep link. No sensitive data.' })
  data!: Record<string, unknown>;

  @ApiProperty({ type: Date, nullable: true })
  readAt!: Date | null;

  @ApiProperty({ type: Date })
  createdAt!: Date;
}

export class UnreadCountDto {
  @ApiProperty()
  count!: number;
}

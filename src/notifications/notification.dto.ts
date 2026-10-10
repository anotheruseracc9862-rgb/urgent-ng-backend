import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationQueryDto } from '../common/pagination/pagination.dto.js';

export class NotificationListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Only notifications not yet read.' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unread?: boolean;
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

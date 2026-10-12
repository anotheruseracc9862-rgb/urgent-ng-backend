import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { UserStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/pagination/pagination.dto.js';
import { AdminActionDto } from '../../admin/framework/admin-reasons.js';

export class AdminUserListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'A name, an email fragment, the start of a phone number, or a user id.', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}

export class AdminUserSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: UserStatus }) status!: UserStatus;
  @ApiProperty({ nullable: true, type: String, description: 'Masked: 080****1234.' }) phone!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Masked: a***@example.com.' }) email!: string | null;
  @ApiProperty({ description: 'A valid identity verification exists.' }) verified!: boolean;
  @ApiProperty({ description: 'Restrictions or suspensions in force.' }) activeRestrictions!: number;
  @ApiProperty({ type: Date }) createdAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) lastLoginAt!: Date | null;
}

export class AdminUserDetailDto extends AdminUserSummaryDto {
  @ApiProperty({ nullable: true, type: String }) bio!: string | null;
  @ApiProperty({ nullable: true, type: String }) homeArea!: string | null;
  @ApiProperty({ nullable: true, type: String }) startMode!: string | null;
  @ApiProperty({ nullable: true, type: String }) photoMediaId!: string | null;
  @ApiProperty({ type: Object }) stats!: Record<string, unknown>;
  @ApiProperty({ type: Object, description: 'Latest verification state (no identity data).' }) verification!: Record<string, unknown>;
  @ApiProperty({ type: Object }) reliability!: Record<string, unknown>;
  @ApiProperty({ type: Object }) counts!: Record<string, number>;
  @ApiProperty({ type: Object, nullable: true, description: 'Set while a deletion request is open: when it ends and what blocks it.' })
  deletion!: Record<string, unknown> | null;
  @ApiProperty({ type: Object, isArray: true }) restrictions!: Array<Record<string, unknown>>;
  @ApiProperty({ type: Object, isArray: true }) enforcement!: Array<Record<string, unknown>>;
  @ApiProperty({ type: String, isArray: true }) badges!: string[];
}

export class AdminUserContactDto {
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
  @ApiProperty({ nullable: true, type: String }) email!: string | null;
  @ApiProperty() phoneVerified!: boolean;
  @ApiProperty() emailVerified!: boolean;
}

export class SuspendUserDto extends AdminActionDto {
  @ApiProperty({ minimum: 1, maximum: 365, description: 'Days of the suspension. A permanent suspension is a different request that a second admin approves.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days!: number;
}

export class UserActionResultDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: UserStatus }) status!: UserStatus;
}

export class RevokedSessionsDto {
  @ApiProperty() userId!: string;
  @ApiProperty() revoked!: boolean;
}

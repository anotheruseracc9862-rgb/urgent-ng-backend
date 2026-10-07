import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { MediaPurpose, MediaStatus, ModerationStatus } from '@prisma/client';

export class RequestUploadDto {
  @ApiProperty({ enum: MediaPurpose, enumName: 'MediaPurpose' })
  @IsEnum(MediaPurpose)
  purpose!: MediaPurpose;

  /** `image/jpeg`, `image/png` or `image/webp`. */
  @IsString()
  mimeType!: string;

  /** Exact size in bytes of the file the client is about to upload. */
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}

export class SetProfilePhotoDto {
  /** A READY media row with purpose PROFILE_PHOTO that the caller owns. */
  @IsUUID()
  mediaId!: string;
}

export class MediaUrlQueryDto {
  @ApiPropertyOptional({ enum: ['full', 'thumbnail'], default: 'full' })
  @IsOptional()
  @IsIn(['full', 'thumbnail'])
  variant?: 'full' | 'thumbnail';
}

export class MediaDto {
  id!: string;
  @ApiProperty({ enum: MediaPurpose, enumName: 'MediaPurpose' })
  purpose!: MediaPurpose;
  @ApiProperty({ enum: MediaStatus, enumName: 'MediaStatus' })
  status!: MediaStatus;
  @ApiProperty({ enum: ModerationStatus, enumName: 'ModerationStatus' })
  moderationStatus!: ModerationStatus;
  mimeType!: string;
  sizeBytes!: number;
  @ApiProperty({ nullable: true })
  width!: number | null;
  @ApiProperty({ nullable: true })
  height!: number | null;
  /** Set only when `status` is REJECTED: a stable code such as `NOT_AN_IMAGE` or `TYPE_MISMATCH`. */
  @ApiProperty({ nullable: true })
  rejectionReason!: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt!: Date | null;
}

export class UploadTargetDto {
  /** Upload the file bytes here with an HTTP PUT. */
  url!: string;
  @ApiProperty({ enum: ['PUT'] })
  method!: 'PUT';
  /** Send exactly these headers with the PUT. */
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  headers!: Record<string, string>;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;
}

export class UploadRequestResultDto {
  @ApiProperty({ type: MediaDto })
  media!: MediaDto;
  @ApiProperty({ type: UploadTargetDto })
  upload!: UploadTargetDto;
}

export class MediaUrlDto {
  /** Short-lived signed URL. Fetch it with a plain GET (no auth header). */
  url!: string;
  @ApiProperty({ enum: ['full', 'thumbnail'] })
  variant!: 'full' | 'thumbnail';
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;
}

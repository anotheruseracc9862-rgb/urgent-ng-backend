import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatedShareDto {
  @ApiProperty()
  id!: string;
  @ApiProperty({ description: 'The link secret. It is shown once and cannot be recovered (only a hash is stored).' })
  token!: string;
  @ApiProperty({ description: 'The path to give the trusted contact, relative to the web app.' })
  path!: string;
  @ApiProperty({ type: Date })
  expiresAt!: Date;
}

export class ShareDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  errandId!: string;
  @ApiProperty({ enum: ['CREATED', 'ACTIVE', 'EXPIRED', 'REVOKED'] })
  status!: string;
  @ApiProperty({ description: 'The caller created this link.' })
  createdByMe!: boolean;
  @ApiProperty({ type: Date, description: 'When the link stops working, counting the cap and the end of the errand.' })
  expiresAt!: Date;
  @ApiProperty()
  viewCount!: number;
  @ApiProperty({ type: Date, nullable: true })
  lastViewedAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true })
  concernRaisedAt!: Date | null;
  @ApiProperty({ type: Date })
  createdAt!: Date;
}

export class RaiseConcernDto {
  @ApiPropertyOptional({ maxLength: 500, description: 'What the trusted contact is worried about.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class SharedAreaDto {
  @ApiProperty()
  area!: string;
  @ApiProperty({ nullable: true, type: String })
  lga!: string | null;
  @ApiProperty({ nullable: true, type: String })
  state!: string | null;
  @ApiProperty({ description: 'The centre of a grid cell of about 1 km, never an address.' })
  lat!: number;
  @ApiProperty()
  lng!: number;
}

export class SharedRunnerDto {
  @ApiProperty()
  firstName!: string;
  @ApiProperty()
  lastInitial!: string;
  @ApiProperty({ nullable: true, type: String, description: 'A short-lived signed link to the profile photo, only valid for this share.' })
  photoUrl!: string | null;
  @ApiProperty({ description: 'The runner has a valid identity verification. Nothing of the verification itself is shared.' })
  verified!: boolean;
  @ApiProperty({ nullable: true, type: Number })
  ratingAverage!: number | null;
  @ApiProperty()
  ratingCount!: number;
}

export class SharedCheckpointDto {
  @ApiProperty({ enum: ['PICKED_UP', 'DELIVERED'] })
  type!: string;
  @ApiProperty({ type: Date })
  at!: Date;
}

export class SharedLiveDto {
  @ApiProperty({ enum: ['FRESH', 'STALE', 'EXPIRED', 'NONE'] })
  freshness!: string;
  @ApiProperty({ nullable: true, type: Number })
  lat!: number | null;
  @ApiProperty({ nullable: true, type: Number })
  lng!: number | null;
  @ApiProperty({ type: Date, nullable: true })
  capturedAt!: Date | null;
}

/**
 * What a trusted contact may see (Backend PRD 17.5). No exact address, phone number, chat, exact
 * GPS history, payment detail or verification detail is in here, by construction.
 */
export class SharedErrandDto {
  @ApiProperty()
  title!: string;
  @ApiProperty()
  category!: string;
  @ApiProperty({ enum: ['TRANSIT', 'SERVICE'], description: 'A service is work at one address: there is no pickup, and its steps read as work started and finished.' })
  categoryFlow!: 'TRANSIT' | 'SERVICE';
  @ApiProperty()
  requesterFirstName!: string;
  @ApiProperty({ type: SharedRunnerDto })
  runner!: SharedRunnerDto;
  @ApiProperty({ description: 'The errand status, for example IN_PROGRESS, PICKED_UP or DELIVERED.' })
  status!: string;
  @ApiProperty({ type: SharedCheckpointDto, isArray: true })
  checkpoints!: SharedCheckpointDto[];
  @ApiProperty({ type: SharedAreaDto, nullable: true })
  pickup!: SharedAreaDto | null;
  @ApiProperty({ type: SharedAreaDto, nullable: true })
  destination!: SharedAreaDto | null;
  @ApiProperty({ type: SharedLiveDto, nullable: true, description: 'Only while the errand is active.' })
  live!: SharedLiveDto | null;
  @ApiProperty({ type: Date, description: 'The latest time anything on this errand changed.' })
  lastUpdatedAt!: Date;
  @ApiProperty({ type: Date, nullable: true })
  expectedDeliveryAt!: Date | null;
  @ApiProperty({ type: Date })
  linkExpiresAt!: Date;
}

export class ConcernResultDto {
  @ApiProperty()
  received!: boolean;
}

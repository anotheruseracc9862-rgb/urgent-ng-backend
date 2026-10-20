import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ErrandCancellationReason, ErrandPriority, ErrandStatus, ItemSize, LocationSource, TimeMode } from '@prisma/client';
import { LatLngDto } from '../runner/runner.dto.js';

/** Largest amount accepted for a budget or item value: 100 million naira, in kobo. */
const MAX_MINOR = 10_000_000_000;

/** Where a pin came from. Only these may be sent by a client. */
export const CLIENT_LOCATION_SOURCES = [
  LocationSource.MAP_PIN,
  LocationSource.GEOCODED_ADDRESS,
  LocationSource.BROWSER_GPS,
  LocationSource.MANUAL,
] as const;

export class ErrandLocationInputDto {
  @ApiProperty({ type: LatLngDto })
  @ValidateNested()
  @Type(() => LatLngDto)
  point!: LatLngDto;

  /** Street address as typed or found by search. Private; shown only to the requester and the assigned runner. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  addressText?: string;

  /** A free-text landmark. With a pin, this is always enough to publish. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  landmark?: string;

  @ApiPropertyOptional({ enum: CLIENT_LOCATION_SOURCES, enumName: 'LocationSource', default: LocationSource.MAP_PIN })
  @IsOptional()
  @IsEnum(LocationSource)
  source?: LocationSource;
}

export class ErrandContactInputDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  /** Nigerian number, local (080...) or international (+234...). Stored encrypted. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}

/** Fields an errand carries; every one is optional on PATCH. */
class ErrandFieldsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  instructions?: string;

  @ApiPropertyOptional({ enum: TimeMode, enumName: 'TimeMode' })
  @IsOptional()
  @IsEnum(TimeMode)
  timeMode?: TimeMode;

  /** Required with timeMode SCHEDULED. ISO 8601. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  scheduledAt?: Date;

  /** A guide for runners, not a price. Kobo. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR)
  suggestedBudgetMinor?: number;

  @ApiPropertyOptional({ enum: ItemSize, enumName: 'ItemSize' })
  @IsOptional()
  @IsEnum(ItemSize)
  itemSize?: ItemSize;

  /** Approximate value of what is carried. Informational only. Kobo. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR)
  itemValueMinor?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ErrandLocationInputDto)
  pickup?: ErrandLocationInputDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ErrandLocationInputDto)
  destination?: ErrandLocationInputDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ErrandContactInputDto)
  pickupContact?: ErrandContactInputDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ErrandContactInputDto)
  dropoffContact?: ErrandContactInputDto;

  /** READY media of purpose ERRAND_PHOTO, in display order. At most the configured limit (default 6). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  photoMediaIds?: string[];
}

export class CreateErrandDto extends ErrandFieldsDto {
  @IsUUID()
  categoryId!: string;
}

/** Send only what changes. `pickup`, `destination` and the contacts can be set to `null` to remove them. */
export class UpdateErrandDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  instructions?: string | null;

  @ApiPropertyOptional({ enum: TimeMode, enumName: 'TimeMode' })
  @IsOptional()
  @IsEnum(TimeMode)
  timeMode?: TimeMode;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  scheduledAt?: Date | null;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR)
  suggestedBudgetMinor?: number | null;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsEnum(ItemSize)
  itemSize?: ItemSize | null;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR)
  itemValueMinor?: number | null;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @ValidateNested()
  @Type(() => ErrandLocationInputDto)
  pickup?: ErrandLocationInputDto | null;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @ValidateNested()
  @Type(() => ErrandLocationInputDto)
  destination?: ErrandLocationInputDto | null;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @ValidateNested()
  @Type(() => ErrandContactInputDto)
  pickupContact?: ErrandContactInputDto | null;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @ValidateNested()
  @Type(() => ErrandContactInputDto)
  dropoffContact?: ErrandContactInputDto | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  photoMediaIds?: string[];

  /** The version the client last saw. A different current version is answered with 409 ERRAND_INVALID_STATE. */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

export class PublishErrandDto {
  /** Must be true: the requester confirms the errand carries nothing prohibited (Backend PRD 11.9). */
  @IsBoolean()
  prohibitedItemsConfirmed!: boolean;
}

export class CancelErrandDto {
  @ApiProperty({ enum: ErrandCancellationReason, enumName: 'ErrandCancellationReason' })
  @IsEnum(ErrandCancellationReason)
  reason!: ErrandCancellationReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ---- Responses ----

export class CategoryRefDto {
  id!: string;
  key!: string;
  name!: string;
}

export class PublicLocationDto {
  area!: string;
  @ApiProperty({ nullable: true, type: String })
  lga!: string | null;
  @ApiProperty({ nullable: true, type: String })
  state!: string | null;
  /** Approximate point (about 500 m grid plus a private offset). */
  @ApiProperty({ type: LatLngDto })
  approx!: LatLngDto;
}

export class ParticipantLocationDto extends PublicLocationDto {
  @ApiProperty({ type: LatLngDto })
  exact!: LatLngDto;
  @ApiProperty({ nullable: true, type: String })
  addressText!: string | null;
  @ApiProperty({ nullable: true, type: String })
  landmark!: string | null;
}

export class ErrandContactViewDto {
  @ApiProperty({ nullable: true, type: String })
  name!: string | null;
  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;
}

export class ErrandPhotoDto {
  mediaId!: string;
  position!: number;
}

export class ErrandAssignmentSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  runnerId!: string;

  @ApiProperty({ enum: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'DECLINED', 'TIMED_OUT', 'CANCELLED', 'COMPLETED'] })
  status!: 'PENDING_ACCEPTANCE' | 'ACCEPTED' | 'DECLINED' | 'TIMED_OUT' | 'CANCELLED' | 'COMPLETED';

  @ApiProperty({ description: 'The agreed runner fee in kobo.' })
  agreedAmountMinor!: number;

  @ApiProperty({ nullable: true, type: Date })
  acceptedAt!: Date | null;
}

/** What the requester sees of their own errand. */
export class ErrandDto {
  id!: string;
  @ApiProperty({ enum: ErrandStatus, enumName: 'ErrandStatus' })
  status!: ErrandStatus;
  version!: number;
  @ApiProperty({ type: CategoryRefDto })
  category!: CategoryRefDto;
  title!: string;
  description!: string;
  @ApiProperty({ nullable: true, type: String })
  instructions!: string | null;
  @ApiProperty({ enum: ErrandPriority, enumName: 'ErrandPriority' })
  priority!: ErrandPriority;
  @ApiProperty({ enum: TimeMode, enumName: 'TimeMode', nullable: true })
  timeMode!: TimeMode | null;
  @ApiProperty({ nullable: true, type: Date })
  scheduledAt!: Date | null;
  @ApiProperty({ nullable: true, type: Number })
  suggestedBudgetMinor!: number | null;
  @ApiProperty({ enum: ItemSize, enumName: 'ItemSize', nullable: true })
  itemSize!: ItemSize | null;
  @ApiProperty({ nullable: true, type: Number })
  itemValueMinor!: number | null;
  @ApiProperty({ type: ParticipantLocationDto, nullable: true })
  pickup!: ParticipantLocationDto | null;
  @ApiProperty({ type: ParticipantLocationDto, nullable: true })
  destination!: ParticipantLocationDto | null;
  @ApiProperty({ type: ErrandContactViewDto, nullable: true })
  pickupContact!: ErrandContactViewDto | null;
  @ApiProperty({ type: ErrandContactViewDto, nullable: true })
  dropoffContact!: ErrandContactViewDto | null;
  @ApiProperty({ type: [ErrandPhotoDto] })
  photos!: ErrandPhotoDto[];
  @ApiProperty({ type: ErrandAssignmentSummaryDto, nullable: true })
  assignment!: ErrandAssignmentSummaryDto | null;
  offerCount!: number;
  @ApiProperty({ nullable: true, type: Date })
  publishedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date })
  expiresAt!: Date | null;
  /** When a delivered errand completes by itself. Null when none is running, or a report or dispute holds it. */
  @ApiProperty({ nullable: true, type: Date })
  autoCompleteAt!: Date | null;
  /** True once the requester has used the one allowed extension. */
  extended!: boolean;
  @ApiProperty({ nullable: true, type: Date })
  cancelledAt!: Date | null;
  @ApiProperty({ enum: ErrandCancellationReason, enumName: 'ErrandCancellationReason', nullable: true })
  cancellationReason!: ErrandCancellationReason | null;
  createdAt!: Date;
  updatedAt!: Date;
}

/** One line of the requester's own list. */
export const ERRAND_ATTENTION = ['OFFERS', 'RUNNER_TO_CONFIRM', 'DELIVERY', 'CHANGE_REQUEST', 'EXPIRING'] as const;
export type ErrandAttention = (typeof ERRAND_ATTENTION)[number];

export class OfferPreviewDto {
  @ApiProperty()
  firstName!: string;
  @ApiProperty({ nullable: true, type: String })
  lastName!: string | null;
  @ApiProperty({ nullable: true, type: String })
  photoMediaId!: string | null;
}

export class ErrandRunnerSummaryDto {
  @ApiProperty()
  firstName!: string;
  @ApiProperty({ nullable: true, type: String })
  lastName!: string | null;
  @ApiProperty({ nullable: true, type: String })
  photoMediaId!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Null until enough ratings are published to show an average.' })
  rating!: number | null;
  @ApiProperty()
  ratingCount!: number;
  @ApiProperty({ description: 'Errands this runner has completed.' })
  completedErrands!: number;
  @ApiProperty({ description: 'The runner has an active Runner Pro entitlement right now.' })
  isPro!: boolean;
}

export class ErrandSummaryDto {
  id!: string;
  @ApiProperty({ enum: ErrandStatus, enumName: 'ErrandStatus' })
  status!: ErrandStatus;
  title!: string;
  @ApiProperty({ type: CategoryRefDto })
  category!: CategoryRefDto;
  @ApiProperty({ enum: ErrandPriority, enumName: 'ErrandPriority' })
  priority!: ErrandPriority;
  @ApiProperty({ enum: TimeMode, enumName: 'TimeMode', nullable: true })
  timeMode!: TimeMode | null;
  @ApiProperty({ nullable: true, type: Date })
  scheduledAt!: Date | null;
  @ApiProperty({ nullable: true, type: Number })
  suggestedBudgetMinor!: number | null;
  @ApiProperty({ nullable: true, type: String })
  pickupArea!: string | null;
  @ApiProperty({ nullable: true, type: String })
  destinationArea!: string | null;
  offerCount!: number;
  @ApiProperty({ nullable: true, type: Date })
  publishedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date })
  expiresAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'The lowest active offer in kobo on an open errand. Null with no active offers or once a runner is selected.',
  })
  lowestOfferMinor!: number | null;
  @ApiProperty({
    type: OfferPreviewDto,
    isArray: true,
    description: 'Up to four runners with active offers, lowest amount first. Empty once a runner is selected.',
  })
  offerPreview!: OfferPreviewDto[];
  @ApiProperty({ type: ErrandRunnerSummaryDto, nullable: true, description: 'The runner on the errand, from selection onward.' })
  runner!: ErrandRunnerSummaryDto | null;
  @ApiProperty({ nullable: true, type: Number, description: 'The agreed amount in kobo, once a runner is selected.' })
  agreedAmountMinor!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'The assignment with the selected runner. Open it at /assignments/{id}.' })
  assignmentId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'The conversation with the selected runner about this errand, if one exists.' })
  conversationId!: string | null;
  @ApiProperty({
    enum: ERRAND_ATTENTION,
    nullable: true,
    description: 'What needs the requester next: OFFERS to review, a RUNNER_TO_CONFIRM, a DELIVERY to confirm, a CHANGE_REQUEST to answer, or an open errand EXPIRING within two hours.',
  })
  attention!: ErrandAttention | null;
  @ApiProperty({ nullable: true, type: Date, description: 'When the attention item lapses: the change request expiry or the errand deadline.' })
  attentionExpiresAt!: Date | null;
}

export class MineCountsDto {
  @ApiProperty({ description: 'Every errand that is not deleted.' })
  all!: number;
  @ApiProperty({ description: 'Errands that need the requester next (the ATTENTION tab).' })
  attention!: number;
  @ApiProperty()
  open!: number;
  @ApiProperty()
  active!: number;
  @ApiProperty()
  past!: number;
  @ApiProperty()
  draft!: number;
}

/** Requester tabs on the dashboard (Backend PRD 30.4). */
export const MINE_TABS = ['DRAFT', 'OPEN', 'ACTIVE', 'PAST', 'ATTENTION'] as const;
export type MineTab = (typeof MINE_TABS)[number];

/** Sort orders of the requester's list: newest first, what needs a reply first, or the largest budget. */
export const MINE_SORTS = ['RECENT', 'NEEDS_ATTENTION', 'HIGHEST_AMOUNT'] as const;
export type MineSort = (typeof MINE_SORTS)[number];

export class MineQueryDto {
  @ApiPropertyOptional({
    enum: MINE_TABS,
    description: 'DRAFT, OPEN (published, no runner yet), ACTIVE (runner selected through delivery, or disputed), PAST (completed, cancelled, expired), ATTENTION (needs the requester next: offers to review, a runner to confirm, a delivery to confirm, a change request, or closing soon). Leave out for all.',
  })
  @IsOptional()
  @IsEnum(MINE_TABS)
  tab?: MineTab;

  @ApiPropertyOptional({ enum: MINE_SORTS, default: 'RECENT', description: 'NEEDS_ATTENTION puts delivered errands, selected runners and errands with offers first.' })
  @IsOptional()
  @IsEnum(MINE_SORTS)
  sort?: MineSort;

  @ApiPropertyOptional({ description: 'Search the title, the description and the name of the selected runner.', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ description: 'Opaque cursor for pagination' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

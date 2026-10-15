import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';

export class SelectRunnerDto {
  @ApiProperty({ description: 'The offer to select.' })
  @IsUUID()
  offerId!: string;

  @ApiProperty({ description: 'The offer version the requester saw. A changed offer answers OFFER_VERSION_MISMATCH.' })
  @IsInt()
  @Min(0)
  expectedOfferVersion!: number;
}

export class CancelAssignmentDto {
  @ApiProperty({
    enum: ['REQUESTER_CANCELLED', 'DUPLICATE_ERRAND', 'SAFETY_CONCERN', 'NO_RUNNER_AVAILABLE', 'RUNNER_CANCELLED', 'OTHER'],
    description: 'Requester: REQUESTER_CANCELLED, DUPLICATE_ERRAND, SAFETY_CONCERN, NO_RUNNER_AVAILABLE, OTHER. Runner: RUNNER_CANCELLED, SAFETY_CONCERN, OTHER.',
  })
  @IsIn(['REQUESTER_CANCELLED', 'DUPLICATE_ERRAND', 'SAFETY_CONCERN', 'NO_RUNNER_AVAILABLE', 'RUNNER_CANCELLED', 'OTHER'])
  reason!: 'REQUESTER_CANCELLED' | 'DUPLICATE_ERRAND' | 'SAFETY_CONCERN' | 'NO_RUNNER_AVAILABLE' | 'RUNNER_CANCELLED' | 'OTHER';

  @ApiPropertyOptional({ description: 'Free text explanation, kept with the cancellation record.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

export class AssignedErrandDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  version!: number;

  @ApiProperty({ type: Object })
  category!: { id: string; key: string; name: string };

  @ApiProperty()
  title!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ nullable: true })
  instructions!: string | null;

  @ApiProperty()
  priority!: string;

  @ApiProperty({ nullable: true })
  timeMode!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  scheduledAt!: Date | null;

  @ApiProperty({ nullable: true })
  itemSize!: string | null;

  @ApiProperty({ nullable: true })
  itemValueMinor!: number | null;

  @ApiProperty({
    type: Object,
    nullable: true,
    description: 'Area, LGA, state and the approximate point. `exact`, `addressText` and `landmark` are present only when accessLevel is EXACT.',
  })
  pickup!: Record<string, unknown> | null;

  @ApiProperty({ type: Object, nullable: true, description: 'Same rule as pickup.' })
  destination!: Record<string, unknown> | null;

  @ApiProperty({ type: Object, nullable: true, description: 'Null unless accessLevel is EXACT.' })
  pickupContact!: { name: string | null; phone: string | null } | null;

  @ApiProperty({ type: Object, nullable: true, description: 'Null unless accessLevel is EXACT.' })
  dropoffContact!: { name: string | null; phone: string | null } | null;

  @ApiProperty({ type: Object, isArray: true })
  photos!: Array<{ mediaId: string; position: number }>;

  @ApiProperty({ type: Date, nullable: true })
  expiresAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true, description: 'When a delivered errand completes by itself. Null when none is running, or a report or dispute holds it.' })
  autoCompleteAt!: Date | null;

  @ApiProperty({ enum: ['APPROXIMATE', 'EXACT'] })
  accessLevel!: 'APPROXIMATE' | 'EXACT';
}

export class AssignmentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  errandId!: string;

  @ApiProperty()
  offerId!: string;

  @ApiProperty()
  requesterId!: string;

  @ApiProperty()
  runnerId!: string;

  @ApiProperty({ enum: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'DECLINED', 'TIMED_OUT', 'CANCELLED', 'COMPLETED'] })
  status!: string;

  @ApiProperty({ description: 'The runner fee agreed at selection, in kobo. Not a payment held by Urgent.ng.' })
  agreedAmountMinor!: number;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ type: Date })
  selectedAt!: Date;

  @ApiProperty({ type: Date, description: 'The runner must accept before this time (server clock).' })
  acceptanceDeadline!: Date;

  @ApiPropertyOptional({ type: Date, nullable: true })
  acceptedAt!: Date | null;

  @ApiPropertyOptional({ type: Date, nullable: true })
  declinedAt!: Date | null;

  @ApiPropertyOptional({ type: Date, nullable: true })
  timedOutAt!: Date | null;

  @ApiPropertyOptional({ type: Date, nullable: true })
  cancelledAt!: Date | null;

  @ApiPropertyOptional({ type: Date, nullable: true })
  completedAt!: Date | null;

  @ApiProperty()
  version!: number;
}

export class AssignmentDetailDto extends AssignmentDto {
  @ApiProperty({ enum: ['REQUESTER', 'RUNNER'], description: 'The caller\'s side of this assignment.' })
  role!: 'REQUESTER' | 'RUNNER';

  @ApiPropertyOptional({ type: String, nullable: true, description: 'The latest non-deleted dispute for this assignment, or null. Visible only to its parties.' })
  disputeId?: string | null;

  @ApiProperty({ type: AssignedErrandDto, description: 'The errand as this caller may see it. Exact locations and contacts only for the requester, and for the runner while the assignment is ACCEPTED.' })
  errand!: AssignedErrandDto;
}

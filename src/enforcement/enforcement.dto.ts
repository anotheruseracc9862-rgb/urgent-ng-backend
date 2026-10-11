import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class AppealDto {
  @ApiProperty({ minLength: 1, maxLength: 1000, description: 'Why the decision should be reconsidered.' })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  note!: string;
}

export class AppealStateDto {
  @ApiProperty({ type: Date, nullable: true })
  requestedAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true, description: 'When Urgent.ng aims to answer.' })
  dueAt!: Date | null;
  @ApiProperty({ enum: ['UPHELD', 'REVOKED'], nullable: true, description: 'UPHELD: the action stands. REVOKED: the action was lifted.' })
  outcome!: string | null;
  @ApiProperty({ type: Date, nullable: true })
  decidedAt!: Date | null;
}

/** One action on the caller's account, as the caller sees it. */
export class EnforcementActionDto {
  @ApiProperty()
  id!: string;
  @ApiProperty({
    enum: ['WARNING', 'FEATURE_RESTRICTION', 'TEMPORARY_SUSPENSION', 'PERMANENT_SUSPENSION', 'BADGE_REMOVAL', 'VERIFICATION_REVOCATION', 'CONTENT_REMOVAL'],
  })
  type!: string;
  @ApiProperty({ enum: ['ACTIVE', 'EXPIRED', 'REVOKED'] })
  status!: string;
  @ApiProperty({ description: 'Why the action was taken.' })
  reason!: string;
  @ApiProperty({ type: Date })
  startsAt!: Date;
  @ApiProperty({ type: Date, nullable: true })
  endsAt!: Date | null;
  @ApiProperty({ description: 'The caller can still appeal this action.' })
  canAppeal!: boolean;
  @ApiProperty({ type: AppealStateDto })
  appeal!: AppealStateDto;
}

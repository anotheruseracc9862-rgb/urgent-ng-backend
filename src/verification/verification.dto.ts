import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsEnum, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { GuarantorRelationship, IdDocumentType, VerificationFailureReason, VerificationStatus } from '@prisma/client';
import { IsNigerianPhone, NormalisePhone } from '../auth/identifier.js';

/** Who the runner says they are. Compared with the NIN or BVN registry record: a mismatch fails the attempt. */
export class IdentityDetailsDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  lastName!: string;

  @ApiProperty({ example: '1994-03-21', description: 'Date of birth, YYYY-MM-DD. The runner must be 18 or older.' })
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateOfBirth must be YYYY-MM-DD' })
  dateOfBirth!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  addressLine?: string;

  @ApiPropertyOptional({ description: 'Local government area.' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  lga?: string;
}

export class IdDocumentDto {
  @ApiProperty({ enum: IdDocumentType, enumName: 'IdDocumentType' })
  @IsEnum(IdDocumentType)
  type!: IdDocumentType;

  @ApiPropertyOptional({ description: 'A READY upload of purpose VERIFICATION_INPUT. Used for manual review only.' })
  @IsOptional()
  @IsUUID()
  mediaId?: string;
}

export class GuarantorDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  fullName!: string;

  @ApiProperty({ enum: GuarantorRelationship, enumName: 'GuarantorRelationship' })
  @IsEnum(GuarantorRelationship)
  relationship!: GuarantorRelationship;

  @ApiProperty({ description: 'Any common Nigerian format; stored as +234XXXXXXXXXX.' })
  @NormalisePhone()
  @IsNigerianPhone()
  phone!: string;
}

export class StartVerificationDto {
  /**
   * The 11-digit National Identification Number. Send this or `bvn`, not both. Sent once, held in
   * memory for the provider call, never stored, logged or returned.
   */
  @ApiPropertyOptional({ description: '11 digits. Send `nin` or `bvn`, not both.' })
  @ValidateIf((o: StartVerificationDto) => o.bvn === undefined || o.nin !== undefined)
  @Matches(/^\d{11}$/, { message: 'nin must be exactly 11 digits' })
  nin?: string;

  /** The 11-digit Bank Verification Number. Same handling as the NIN. */
  @ApiPropertyOptional({ description: '11 digits. Send `nin` or `bvn`, not both.' })
  @IsOptional()
  @Matches(/^\d{11}$/, { message: 'bvn must be exactly 11 digits' })
  bvn?: string;

  /** A READY media row with purpose VERIFICATION_INPUT that the caller owns. */
  @IsUUID()
  selfieMediaId!: string;

  @ApiProperty({ type: IdentityDetailsDto, description: 'Must match the name and date of birth on the NIN or BVN record.' })
  @IsDefined()
  @ValidateNested()
  @Type(() => IdentityDetailsDto)
  identity!: IdentityDetailsDto;

  @ApiPropertyOptional({ type: IdDocumentDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => IdDocumentDto)
  idDocument?: IdDocumentDto;

  @ApiPropertyOptional({ type: GuarantorDto, description: 'Kept for manual review. Never blocks an automatic approval.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => GuarantorDto)
  guarantor?: GuarantorDto;
}

export class VerificationSubmissionDto {
  attemptId!: string;
  @ApiPropertyOptional({ nullable: true }) firstName!: string | null;
  @ApiPropertyOptional({ nullable: true }) lastName!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'YYYY-MM-DD' }) dateOfBirth!: string | null;
  @ApiPropertyOptional({ nullable: true }) addressLine!: string | null;
  @ApiPropertyOptional({ nullable: true }) lga!: string | null;
  @ApiProperty({ enum: IdDocumentType, enumName: 'IdDocumentType', nullable: true }) idDocumentType!: IdDocumentType | null;
  @ApiPropertyOptional({ nullable: true }) idDocumentMediaId!: string | null;
  @ApiPropertyOptional({ nullable: true }) guarantorName!: string | null;
  @ApiProperty({ enum: GuarantorRelationship, enumName: 'GuarantorRelationship', nullable: true }) guarantorRelationship!: GuarantorRelationship | null;
  @ApiPropertyOptional({ nullable: true }) guarantorPhone!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) submittedAt!: Date;
}

const DISPLAY = ['NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'];

export class VerificationAttemptDto {
  id!: string;
  @ApiProperty({ enum: VerificationStatus, enumName: 'VerificationStatus' })
  status!: VerificationStatus;
  /** What to show the runner: PENDING and REVIEW_REQUIRED are "PENDING", FAILED and REVOKED are "REJECTED". */
  @ApiProperty({ enum: DISPLAY })
  displayStatus!: string;
  @ApiProperty({ enum: VerificationFailureReason, enumName: 'VerificationFailureReason', nullable: true })
  failureReason!: VerificationFailureReason | null;
  attemptNumber!: number;
  @ApiProperty({ type: String, format: 'date-time' })
  startedAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: Date | null;
}

export class VerificationOverviewDto {
  /** Current state. `EXPIRED` also covers a verification past its expiry date. */
  @ApiProperty({ enum: Object.values(VerificationStatus) })
  status!: string;
  @ApiProperty({ enum: DISPLAY })
  displayStatus!: string;
  /** True only while a valid verification exists. */
  verified!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: Date | null;
  phoneVerified!: boolean;
  @ApiProperty({ type: VerificationAttemptDto, nullable: true })
  latestAttempt!: VerificationAttemptDto | null;
  attemptsRemaining!: number;
  /** When the next attempt is allowed, if the runner has to wait. */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  nextAttemptAt!: Date | null;
  feeRequired!: boolean;
  /** True when `POST /verification/attempts` would be accepted now. */
  canStart!: boolean;
}

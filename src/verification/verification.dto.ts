import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, Matches } from 'class-validator';
import { VerificationFailureReason, VerificationStatus } from '@prisma/client';

export class StartVerificationDto {
  /**
   * The 11-digit National Identification Number. Sent once, held in memory for the provider
   * call, never stored, logged or returned.
   */
  @Matches(/^\d{11}$/, { message: 'nin must be exactly 11 digits' })
  nin!: string;

  /** A READY media row with purpose VERIFICATION_INPUT that the caller owns. */
  @IsUUID()
  selfieMediaId!: string;
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

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ConsentType,
  DeviceType,
  NotificationCategory,
  NotificationChannel,
  StartMode,
  UserStatus,
} from '@prisma/client';

export class RegisterResultDto {
  userId!: string;
  /** Where the verification code was sent (phone when both were given). */
  @ApiProperty({ enum: ['phone', 'email'] })
  verifyVia!: 'phone' | 'email';
  /** False when the code could not be sent; call `POST /auth/otp/resend`. */
  otpSent!: boolean;
}

export class VerifiedDto {
  verified!: boolean;
}

export class SentDto {
  sent!: boolean;
}

export class LoggedOutDto {
  loggedOut!: boolean;
}

export class ResetDto {
  reset!: boolean;
}

/**
 * Web clients receive the tokens as HTTP-only cookies (`ung_at`, `ung_rt`) and only
 * `userId`, `status` and `expiresIn` in the body. Mobile clients (`X-Client: mobile`)
 * also receive `accessToken` and `refreshToken` in the body.
 */
export class LoginResultDto {
  userId!: string;
  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus' })
  status!: UserStatus;
  /** Seconds until the access token expires. */
  expiresIn!: number;
  @ApiPropertyOptional({ description: 'Mobile only (X-Client: mobile).' })
  accessToken?: string;
  @ApiPropertyOptional({ description: 'Mobile only (X-Client: mobile).' })
  refreshToken?: string;
}

export class GoogleLoginResultDto extends LoginResultDto {
  @ApiProperty({ description: 'True when this sign-in created the account.' })
  isNewAccount!: boolean;
}

export class RefreshResultDto {
  expiresIn!: number;
  @ApiPropertyOptional({ description: 'Mobile only (X-Client: mobile).' })
  accessToken?: string;
  @ApiPropertyOptional({ description: 'Mobile only (X-Client: mobile).' })
  refreshToken?: string;
}

export class MeDto {
  id!: string;
  name!: string;
  firstName!: string;
  lastName!: string;
  @ApiProperty({ nullable: true })
  phone!: string | null;
  phoneVerified!: boolean;
  @ApiProperty({ nullable: true })
  email!: string | null;
  emailVerified!: boolean;
  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus' })
  status!: UserStatus;
  @ApiProperty({ enum: StartMode, enumName: 'StartMode', nullable: true })
  startMode!: StartMode | null;
  @ApiProperty({ nullable: true })
  photoMediaId!: string | null;
  @ApiProperty({ nullable: true, description: 'A short line about the user.' })
  bio!: string | null;
  @ApiProperty({ nullable: true, description: 'Where the user is based.' })
  homeArea!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deletionScheduledAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class RatingFigureDto {
  /** Published ratings counted. */
  count!: number;
  /** Null until there are enough published ratings to show an average. */
  @ApiProperty({ nullable: true, type: Number })
  average!: number | null;
}

export class PublicStatsDto {
  completedAsRunner!: number;
  completedAsRequester!: number;
  @ApiProperty({ type: RatingFigureDto })
  runnerRating!: RatingFigureDto;
  @ApiProperty({ type: RatingFigureDto })
  requesterRating!: RatingFigureDto;
}

export class PublicProfileDto {
  id!: string;
  firstName!: string;
  lastInitial!: string;
  @ApiProperty({ nullable: true })
  photoMediaId!: string | null;
  @ApiProperty({ nullable: true })
  bio!: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  memberSince!: Date;
  @ApiProperty({ type: String, isArray: true, description: 'Earned badges, strongest first.' })
  badges!: string[];
  @ApiProperty({ type: PublicStatsDto })
  stats!: PublicStatsDto;
}

export class ContactChangeSentDto {
  @ApiProperty({ description: 'The new value, masked, that the code was sent to.' })
  sentTo!: string;
}

export class ContactChangedDto {
  @ApiProperty({ enum: ['phone', 'email'] })
  kind!: 'phone' | 'email';
  @ApiProperty({ description: 'The new value, masked.' })
  value!: string;
}

export class QuietHoursViewDto {
  @ApiProperty({ example: '22:00', description: 'HH:mm, Lagos time.' })
  start!: string;
  @ApiProperty({ example: '06:00' })
  end!: string;
  @ApiProperty({ description: 'True when the user set none and the platform default applies.' })
  isDefault!: boolean;
}

export class AccountChangeDto {
  @ApiProperty({ enum: ['ACTIVE', 'DEACTIVATED', 'DELETION_PENDING'] })
  status!: 'ACTIVE' | 'DEACTIVATED' | 'DELETION_PENDING';
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  deletionScheduledAt?: Date | null;
}

export class SessionDto {
  id!: string;
  /** True for the login making this request. */
  current!: boolean;
  @ApiProperty({ nullable: true })
  userAgent!: string | null;
  @ApiProperty({ nullable: true })
  ip!: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  startedAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  lastRefreshedAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;
}

export class PreferenceEntryViewDto {
  @ApiProperty({ enum: NotificationCategory, enumName: 'NotificationCategory' })
  category!: NotificationCategory;
  @ApiProperty({ enum: NotificationChannel, enumName: 'NotificationChannel' })
  channel!: NotificationChannel;
  enabled!: boolean;
}

export class ConsentViewDto {
  id!: string;
  @ApiProperty({ enum: ConsentType, enumName: 'ConsentType' })
  type!: ConsentType;
  version!: string;
  @ApiProperty({ type: String, format: 'date-time' })
  acceptedAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  withdrawnAt!: Date | null;
}

export class PolicyVersionDto {
  id!: string;
  @ApiProperty({ enum: ConsentType, enumName: 'ConsentType' })
  type!: ConsentType;
  version!: string;
  documentRef!: string;
  @ApiProperty({ type: String, format: 'date-time' })
  publishedAt!: Date;
  requiresReacceptance!: boolean;
}

export class ConsentHistoryDto {
  @ApiProperty({ type: [ConsentViewDto] })
  consents!: ConsentViewDto[];
  /** Policies whose current version the user still has to accept. */
  @ApiProperty({ type: [PolicyVersionDto] })
  outstanding!: PolicyVersionDto[];
}

export class DeviceViewDto {
  id!: string;
  @ApiProperty({ enum: DeviceType, enumName: 'DeviceType' })
  type!: DeviceType;
  active!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastSeenAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class BlockedUserDto {
  userId!: string;
  firstName!: string;
  lastInitial!: string;
  @ApiProperty({ type: String, format: 'date-time' })
  blockedAt!: Date;
}

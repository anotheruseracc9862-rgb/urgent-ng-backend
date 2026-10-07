import { ApiProperty } from '@nestjs/swagger';

export class AdminViewDto {
  id!: string;
  email!: string;
  displayName!: string;
  roles!: string[];
  /** Permission keys (Backend PRD 24.2), for example `USERS_VIEW`. */
  permissions!: string[];
}

/** Step 1 of admin login. No session exists yet. */
export class AdminLoginStepDto {
  /** `MFA_ENROLMENT_REQUIRED` on the first login, `MFA_REQUIRED` afterwards. */
  @ApiProperty({ enum: ['MFA_REQUIRED', 'MFA_ENROLMENT_REQUIRED'] })
  status!: 'MFA_REQUIRED' | 'MFA_ENROLMENT_REQUIRED';
  /** Valid for 5 minutes; accepted only by the MFA endpoints. */
  mfaToken!: string;
}

export class MfaEnrolmentDto {
  /** Base32 TOTP secret to add to an authenticator app. */
  secret!: string;
  otpauthUri!: string;
}

export class AdminSessionResultDto {
  admin!: AdminViewDto;
  expiresIn!: number;
  accessToken!: string;
  refreshToken!: string;
}

export class AdminRefreshResultDto {
  expiresIn!: number;
  accessToken!: string;
  refreshToken!: string;
}

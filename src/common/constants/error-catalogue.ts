import { HttpStatus } from '@nestjs/common';
import * as Codes from './error-codes.js';

export type ErrorCode = (typeof Codes)[keyof typeof Codes];

export interface ErrorCatalogueEntry {
  status: HttpStatus;
  message: string;
}

/**
 * One place that decides the HTTP status and default message of every
 * business error code, so the same code can never be thrown with two
 * different statuses (Backend PRD section 31).
 */
export const ERROR_CATALOGUE: Record<ErrorCode, ErrorCatalogueEntry> = {
  [Codes.AUTH_REQUIRED]: { status: HttpStatus.UNAUTHORIZED, message: 'Authentication is required.' },
  [Codes.FORBIDDEN]: { status: HttpStatus.FORBIDDEN, message: 'You are not allowed to do this.' },
  [Codes.ACCOUNT_SUSPENDED]: { status: HttpStatus.FORBIDDEN, message: 'This account is suspended.' },
  [Codes.ACCOUNT_DEACTIVATED]: { status: HttpStatus.FORBIDDEN, message: 'This account is deactivated.' },
  [Codes.ACCOUNT_DELETION_PENDING]: { status: HttpStatus.FORBIDDEN, message: 'This account is pending deletion.' },
  [Codes.DELETION_BLOCKED]: { status: HttpStatus.CONFLICT, message: 'The account cannot be deleted yet.' },
  [Codes.POLICY_ACCEPTANCE_REQUIRED]: { status: HttpStatus.FORBIDDEN, message: 'You must accept the latest policy to continue.' },
  [Codes.OTP_INVALID]: { status: HttpStatus.BAD_REQUEST, message: 'The code is not correct.' },
  [Codes.OTP_EXPIRED]: { status: HttpStatus.BAD_REQUEST, message: 'The code has expired.' },
  [Codes.OTP_RATE_LIMITED]: { status: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many codes requested. Try again later.' },
  [Codes.USER_BLOCKED]: { status: HttpStatus.FORBIDDEN, message: 'This action is not available between these users.' },
  [Codes.FEATURE_DISABLED]: { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'This feature is temporarily unavailable.' },
  [Codes.GOOGLE_SIGNUP_REQUIRED]: { status: HttpStatus.CONFLICT, message: 'There is no account for this Google user yet. Accept the policies to create one.' },
  [Codes.SIGN_IN_PROVIDER_UNAVAILABLE]: { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Google sign-in is not available right now. Use your phone or email instead.' },
  [Codes.INVALID_CREDENTIALS]: { status: HttpStatus.UNAUTHORIZED, message: 'The phone, email or password is not correct.' },
  [Codes.ACCOUNT_LOCKED]: { status: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many failed attempts. Try again later.' },
  [Codes.IDENTIFIER_TAKEN]: { status: HttpStatus.CONFLICT, message: 'This phone number or email is already registered.' },
  [Codes.REGISTRATION_BLOCKED]: { status: HttpStatus.FORBIDDEN, message: 'Registration is not available for this phone number or email.' },
  [Codes.OTP_DELIVERY_FAILED]: { status: HttpStatus.BAD_GATEWAY, message: 'The code could not be sent. Try again.' },
  [Codes.MFA_REQUIRED]: { status: HttpStatus.UNAUTHORIZED, message: 'A verification code from your authenticator app is required.' },
  [Codes.MFA_ENROLMENT_REQUIRED]: { status: HttpStatus.UNAUTHORIZED, message: 'Set up two-factor authentication to continue.' },
  [Codes.MFA_INVALID]: { status: HttpStatus.UNAUTHORIZED, message: 'The verification code is not correct.' },

  [Codes.INTERNAL_ERROR]: { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'An unexpected error occurred.' },
  [Codes.VALIDATION_ERROR]: { status: HttpStatus.BAD_REQUEST, message: 'The request is not valid.' },
  [Codes.RESOURCE_NOT_FOUND]: { status: HttpStatus.NOT_FOUND, message: 'The requested resource was not found.' },
  [Codes.RESOURCE_CONFLICT]: { status: HttpStatus.CONFLICT, message: 'The request conflicts with the current state.' },
  [Codes.IDEMPOTENCY_CONFLICT]: { status: HttpStatus.CONFLICT, message: 'This idempotency key was already used with a different request.' },
  [Codes.RATE_LIMITED]: { status: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many requests. Try again later.' },

  [Codes.ERRAND_INVALID_STATE]: { status: HttpStatus.CONFLICT, message: 'This errand cannot be modified in its current state.' },
  [Codes.ERRAND_EXPIRED]: { status: HttpStatus.CONFLICT, message: 'This errand has expired.' },
  [Codes.ERRAND_NOT_ELIGIBLE]: { status: HttpStatus.UNPROCESSABLE_ENTITY, message: 'This errand is not eligible for this action.' },
  [Codes.SCHEDULE_OUT_OF_RANGE]: { status: HttpStatus.BAD_REQUEST, message: 'The scheduled time is outside the allowed range.' },

  [Codes.OFFER_NOT_ELIGIBLE]: { status: HttpStatus.FORBIDDEN, message: 'You cannot submit an offer on this errand.' },
  [Codes.OFFER_ALREADY_EXISTS]: { status: HttpStatus.CONFLICT, message: 'You already have an active offer on this errand.' },
  [Codes.OFFER_INVALID_STATE]: { status: HttpStatus.CONFLICT, message: 'This offer cannot be changed in its current state.' },
  [Codes.OFFER_VERSION_MISMATCH]: { status: HttpStatus.CONFLICT, message: 'The offer changed. Review the latest version.' },
  [Codes.OFFER_NEEDS_RECONFIRMATION]: { status: HttpStatus.CONFLICT, message: 'The runner must reconfirm this offer.' },
  [Codes.OFFER_AWAITING_RUNNER]: { status: HttpStatus.CONFLICT, message: 'This offer is waiting for the runner to respond.' },
  [Codes.OFFER_ROUND_LIMIT_REACHED]: { status: HttpStatus.CONFLICT, message: 'The counter-offer limit for this negotiation is reached. Accept or decline the latest terms.' },
  [Codes.OFFER_DAILY_LIMIT_REACHED]: { status: HttpStatus.TOO_MANY_REQUESTS, message: "You have reached today's offer limit." },

  [Codes.ASSIGNMENT_INVALID_STATE]: { status: HttpStatus.CONFLICT, message: 'This assignment cannot be changed in its current state.' },
  [Codes.ASSIGNMENT_ACCEPTANCE_EXPIRED]: { status: HttpStatus.CONFLICT, message: 'The acceptance window has expired.' },
  [Codes.ASSIGNMENT_CONFLICT]: { status: HttpStatus.CONFLICT, message: 'Another action was completed first.' },
  [Codes.CHANGE_REQUEST_PENDING]: { status: HttpStatus.CONFLICT, message: 'A change request is already pending.' },
  [Codes.CHANGE_REQUEST_NOT_ALLOWED]: { status: HttpStatus.CONFLICT, message: 'A change request is not allowed at this stage.' },

  [Codes.VERIFICATION_REQUIRED]: { status: HttpStatus.FORBIDDEN, message: 'Identity verification is required.' },
  [Codes.VERIFICATION_PENDING]: { status: HttpStatus.FORBIDDEN, message: 'Your verification is still pending.' },
  [Codes.VERIFICATION_FAILED]: { status: HttpStatus.UNPROCESSABLE_ENTITY, message: 'Identity verification failed.' },
  [Codes.VERIFICATION_FEE_REQUIRED]: { status: HttpStatus.PAYMENT_REQUIRED, message: 'The verification fee must be paid first.' },
  [Codes.DUPLICATE_IDENTITY]: { status: HttpStatus.CONFLICT, message: 'This identity is already registered.' },

  [Codes.LOCATION_PERMISSION_REQUIRED]: { status: HttpStatus.FORBIDDEN, message: 'Location permission is required.' },
  [Codes.LOCATION_NOT_AVAILABLE]: { status: HttpStatus.NOT_FOUND, message: 'Location is not available.' },
  [Codes.MESSAGE_BLOCKED]: { status: HttpStatus.FORBIDDEN, message: 'This message cannot be sent.' },
  [Codes.CONVERSATION_READ_ONLY]: { status: HttpStatus.CONFLICT, message: 'This conversation is read-only.' },
  [Codes.RATING_NOT_ELIGIBLE]: { status: HttpStatus.FORBIDDEN, message: 'You cannot rate this errand.' },
  [Codes.RATING_ALREADY_SUBMITTED]: { status: HttpStatus.CONFLICT, message: 'You have already rated this errand.' },
  [Codes.DISPUTE_ALREADY_OPEN]: { status: HttpStatus.CONFLICT, message: 'A dispute is already open.' },

  [Codes.SUBSCRIPTION_NOT_ACTIVE]: { status: HttpStatus.FORBIDDEN, message: 'An active subscription is required.' },
  [Codes.BOOST_NOT_ELIGIBLE]: { status: HttpStatus.CONFLICT, message: 'This errand cannot be boosted.' },
  [Codes.PAYMENT_PROVIDER_UNAVAILABLE]: { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'The payment service is not available right now. Try again in a moment.' },
  [Codes.MEDIA_INVALID]: { status: HttpStatus.BAD_REQUEST, message: 'The file is not valid.' },
  [Codes.MEDIA_NOT_READY]: { status: HttpStatus.CONFLICT, message: 'The file is still being processed.' },
};

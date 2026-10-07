import { Transform } from 'class-transformer';
import { registerDecorator, type ValidationOptions } from 'class-validator';
import { isValidNigerianPhone, normalizePhone } from '../common/utils/phone.helper.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { VALIDATION_ERROR } from '../common/constants/error-codes.js';

export type IdentifierKind = 'phone' | 'email';

export interface Identifier {
  kind: IdentifierKind;
  /** E.164 phone (+234...) or lower-cased email. */
  value: string;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Exactly one of phone / email. Used for login, OTP and password reset, where a
 * request names a single account identifier.
 */
export function singleIdentifier(input: { phone?: string; email?: string }): Identifier {
  const hasPhone = typeof input.phone === 'string' && input.phone !== '';
  const hasEmail = typeof input.email === 'string' && input.email !== '';

  if (hasPhone === hasEmail) {
    throw DomainException.of(VALIDATION_ERROR, {
      message: 'Provide either a phone number or an email address.',
    });
  }
  return hasPhone
    ? { kind: 'phone', value: input.phone as string }
    : { kind: 'email', value: input.email as string };
}

/** Class-validator rule: a valid Nigerian mobile number (any common format). */
export function IsNigerianPhone(options?: ValidationOptions) {
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: 'isNigerianPhone',
      target: target.constructor,
      propertyName,
      options: {
        message: 'Enter a valid Nigerian mobile number',
        ...options,
      },
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isValidNigerianPhone(value),
      },
    });
  };
}

/** Normalise an incoming phone to E.164 before validation (leaves invalid input as is). */
export const NormalisePhone = () =>
  Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    return isValidNigerianPhone(value) ? normalizePhone(value) : value;
  });

/** Trim and lower-case an incoming email before validation. */
export const NormaliseEmail = () =>
  Transform(({ value }) => (typeof value === 'string' ? normaliseEmail(value) : value));

/** Mask an identifier for logs and audit metadata: first 2 and last 2 characters. */
export function maskIdentifier(value: string): string {
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

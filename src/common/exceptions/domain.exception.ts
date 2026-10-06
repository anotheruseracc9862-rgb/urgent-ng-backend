import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CATALOGUE, ErrorCode } from '../constants/error-catalogue.js';

export interface DomainExceptionOptions {
  message?: string;
  details?: unknown;
}

/**
 * Domain exception for business errors.
 * Extends HttpException with a stable error code and optional details.
 *
 * Prefer `DomainException.of(CODE)`: the HTTP status and default message come
 * from the error catalogue, so a code always maps to one status.
 */
export class DomainException extends HttpException {
  public readonly code: string;
  public readonly httpStatus: HttpStatus;
  public readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    httpStatus: HttpStatus,
    details?: unknown,
  ) {
    super(message, httpStatus);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }

  static of(
    code: ErrorCode,
    options: DomainExceptionOptions = {},
  ): DomainException {
    const entry = ERROR_CATALOGUE[code];
    return new DomainException(
      code,
      options.message ?? entry.message,
      entry.status,
      options.details,
    );
  }

  getCode(): string {
    return this.code;
  }

  getMessage(): string {
    return this.message;
  }

  getDetails(): unknown {
    return this.details;
  }
}

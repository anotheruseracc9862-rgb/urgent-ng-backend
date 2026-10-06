import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Domain exception for business errors
 * Extends HttpException with a stable error code and optional details
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

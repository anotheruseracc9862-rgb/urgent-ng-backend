import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library.js';
import { DomainException } from '../exceptions/domain.exception.js';
import * as ErrorCodes from '../constants/error-codes.js';

/**
 * Global exception filter that transforms all exceptions into the standard error envelope
 * Response format: { error: { code, message, details? }, requestId }
 */
@Injectable()
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    // Extract requestId from header, fallback to 'unknown'
    const requestId =
      (request.headers['x-request-id'] as string) || 'unknown';

    let statusCode: number;
    let errorCode: string;
    let errorMessage: string;
    let errorDetails: unknown = undefined;

    if (exception instanceof DomainException) {
      // Domain exception: use its code, message, status, and details
      statusCode = exception.httpStatus;
      errorCode = exception.code;
      errorMessage = exception.message;
      errorDetails = exception.details;
    } else if (exception instanceof PrismaClientKnownRequestError) {
      // Prisma errors: map specific error codes
      const prismaError = exception as PrismaClientKnownRequestError;
      const result = this.mapPrismaError(prismaError);
      statusCode = result.status;
      errorCode = result.code;
      errorMessage = result.message;
    } else if (exception instanceof HttpException) {
      // NestJS HttpException (not DomainException)
      statusCode = exception.getStatus();
      errorCode = this.mapHttpStatusToCode(statusCode);
      const mapped = this.describeHttpException(exception, statusCode);
      errorMessage = mapped.message;
      errorDetails = mapped.details;
    } else {
      // Unknown errors: return generic 500 without exposing internal details
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      errorCode = ErrorCodes.INTERNAL_ERROR;
      errorMessage = 'An unexpected error occurred';

      // Log the full error for internal debugging but never expose it in the response
      this.logger.error(
        'Unhandled exception',
        exception instanceof Error ? exception.stack : exception,
      );
    }

    const errorResponse = {
      error: {
        code: errorCode,
        message: errorMessage,
        ...(errorDetails !== undefined && { details: errorDetails }),
      },
      requestId,
    };

    response.status(statusCode).json(errorResponse);
  }

  /**
   * Turn a Nest HttpException into a safe message plus structured details:
   * - class-validator failures keep their per-field messages in details.fields
   * - Terminus health failures keep their per-component results in details.health
   * - 5xx messages (other than 503) are never passed through to the client
   */
  private describeHttpException(
    exception: HttpException,
    status: number,
  ): { message: string; details?: unknown } {
    if (status >= 500 && status !== HttpStatus.SERVICE_UNAVAILABLE) {
      return { message: 'An unexpected error occurred' };
    }

    const body = exception.getResponse();
    if (typeof body === 'object' && body !== null) {
      const record = body as Record<string, unknown>;

      if (Array.isArray(record.message)) {
        return {
          message: 'The request is not valid.',
          details: { fields: record.message },
        };
      }

      if (
        status === HttpStatus.SERVICE_UNAVAILABLE &&
        record.status === 'error' &&
        'details' in record
      ) {
        return {
          message: 'One or more required services are unavailable.',
          details: {
            health: {
              info: record.info,
              error: record.error,
              details: record.details,
            },
          },
        };
      }
    }

    return { message: exception.message || 'An error occurred' };
  }

  private mapPrismaError(error: PrismaClientKnownRequestError): {
    status: number;
    code: string;
    message: string;
  } {
    switch (error.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCodes.RESOURCE_CONFLICT,
          message: 'A resource with this value already exists.',
        };
      case 'P2003':
        return {
          status: HttpStatus.BAD_REQUEST,
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid reference to a related resource.',
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: ErrorCodes.RESOURCE_NOT_FOUND,
          message: 'The requested resource was not found.',
        };
      default:
        // Other Prisma errors treated as internal errors
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'An unexpected error occurred',
        };
    }
  }

  private mapHttpStatusToCode(status: number): string {
    if (status >= 400 && status < 500) {
      switch (status) {
        case HttpStatus.BAD_REQUEST:
          return ErrorCodes.VALIDATION_ERROR;
        case HttpStatus.UNAUTHORIZED:
          return ErrorCodes.AUTH_REQUIRED;
        case HttpStatus.FORBIDDEN:
          return ErrorCodes.FORBIDDEN;
        case HttpStatus.NOT_FOUND:
          return ErrorCodes.RESOURCE_NOT_FOUND;
        case HttpStatus.CONFLICT:
          return ErrorCodes.RESOURCE_CONFLICT;
        case HttpStatus.TOO_MANY_REQUESTS:
          return ErrorCodes.RATE_LIMITED;
        default:
          return ErrorCodes.VALIDATION_ERROR;
      }
    }

    return ErrorCodes.INTERNAL_ERROR;
  }
}

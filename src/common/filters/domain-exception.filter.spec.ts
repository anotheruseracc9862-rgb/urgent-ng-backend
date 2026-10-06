import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { ArgumentsHost } from '@nestjs/common';
import { DomainExceptionFilter } from './domain-exception.filter.js';
import { DomainException } from '../exceptions/domain.exception.js';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library.js';
import * as ErrorCodes from '../constants/error-codes.js';

describe('DomainExceptionFilter', () => {
  let filter: DomainExceptionFilter;
  let mockResponse: any;
  let mockRequest: any;
  let mockArgumentsHost: ArgumentsHost;

  beforeEach(() => {
    filter = new DomainExceptionFilter();

    mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    mockRequest = {
      headers: {},
    };

    mockArgumentsHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as ArgumentsHost;
  });

  describe('DomainException handling', () => {
    it('should return DomainException with correct code, message, status, and requestId', () => {
      mockRequest.headers['x-request-id'] = 'req_123';

      const exception = new DomainException(
        ErrorCodes.ERRAND_INVALID_STATE,
        'Errand cannot be modified in this state',
        HttpStatus.BAD_REQUEST,
        { currentState: 'COMPLETED' },
      );

      filter.catch(exception, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: ErrorCodes.ERRAND_INVALID_STATE,
          message: 'Errand cannot be modified in this state',
          details: { currentState: 'COMPLETED' },
        },
        requestId: 'req_123',
      });
    });

    it('should handle DomainException without details', () => {
      mockRequest.headers['x-request-id'] = 'req_456';

      const exception = new DomainException(
        ErrorCodes.AUTH_REQUIRED,
        'Authentication is required',
        HttpStatus.UNAUTHORIZED,
      );

      filter.catch(exception, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.UNAUTHORIZED,
      );
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: ErrorCodes.AUTH_REQUIRED,
          message: 'Authentication is required',
        },
        requestId: 'req_456',
      });
    });
  });

  describe('Prisma error handling', () => {
    it('should map P2002 to RESOURCE_CONFLICT with 409 status', () => {
      mockRequest.headers['x-request-id'] = 'req_789';

      const prismaError = new PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: '6.0.0',
        },
      );

      filter.catch(prismaError, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: ErrorCodes.RESOURCE_CONFLICT,
          message: 'A resource with this value already exists.',
        },
        requestId: 'req_789',
      });
    });

    it('should map P2003 to VALIDATION_ERROR with 400 status', () => {
      mockRequest.headers['x-request-id'] = 'req_abc';

      const prismaError = new PrismaClientKnownRequestError(
        'Foreign key constraint failed',
        {
          code: 'P2003',
          clientVersion: '6.0.0',
        },
      );

      filter.catch(prismaError, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.BAD_REQUEST,
      );
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid reference to a related resource.',
        },
        requestId: 'req_abc',
      });
    });

    it('should map P2025 to RESOURCE_NOT_FOUND with 404 status', () => {
      mockRequest.headers['x-request-id'] = 'req_def';

      const prismaError = new PrismaClientKnownRequestError(
        'Record not found',
        {
          code: 'P2025',
          clientVersion: '6.0.0',
        },
      );

      filter.catch(prismaError, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: ErrorCodes.RESOURCE_NOT_FOUND,
          message: 'The requested resource was not found.',
        },
        requestId: 'req_def',
      });
    });
  });

  describe('Unknown error handling', () => {
    it('should return 500 with generic message for unknown errors', () => {
      mockRequest.headers['x-request-id'] = 'req_error';

      const unknownError = new Error('Something went wrong internally');

      filter.catch(unknownError, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        },
        requestId: 'req_error',
      });
    });

    it('should not expose stack trace or internal error message', () => {
      mockRequest.headers['x-request-id'] = 'req_trace';

      const error = new Error('Database connection failed');
      error.stack = 'Error: Database connection failed\n    at ...';

      filter.catch(error, mockArgumentsHost);

      const callArgs = mockResponse.json.mock.calls[0][0];
      expect(callArgs.error.message).toBe('An unexpected error occurred');
      expect(callArgs.error.message).not.toContain('Database connection');
      expect(callArgs.error.stack).toBeUndefined();
      expect(callArgs.stack).toBeUndefined();
    });
  });

  describe('Request ID handling', () => {
    it('should use x-request-id from headers when present', () => {
      mockRequest.headers['x-request-id'] = 'custom_req_id';

      const exception = new DomainException(
        ErrorCodes.VALIDATION_ERROR,
        'Invalid input',
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockArgumentsHost);

      const callArgs = mockResponse.json.mock.calls[0][0];
      expect(callArgs.requestId).toBe('custom_req_id');
    });

    it('should use "unknown" when x-request-id header is missing', () => {
      // No x-request-id header set

      const exception = new DomainException(
        ErrorCodes.VALIDATION_ERROR,
        'Invalid input',
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockArgumentsHost);

      const callArgs = mockResponse.json.mock.calls[0][0];
      expect(callArgs.requestId).toBe('unknown');
    });
  });
});

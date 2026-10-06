import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RequestIdMiddleware } from './request-id.middleware.js';
import { PinoLogger } from 'nestjs-pino';
import { Request, Response, NextFunction } from 'express';

describe('RequestIdMiddleware', () => {
  let middleware: RequestIdMiddleware;
  let logger: PinoLogger;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    logger = {
      assign: vi.fn(),
    } as unknown as PinoLogger;

    middleware = new RequestIdMiddleware(logger);

    mockRequest = {
      headers: {},
    };
    mockResponse = {};
    mockNext = vi.fn();
  });

  it('should generate requestId if not present', () => {
    middleware.use(
      mockRequest as Request,
      mockResponse as Response,
      mockNext,
    );

    expect(mockRequest.headers?.['x-request-id']).toBeDefined();
    expect(typeof mockRequest.headers?.['x-request-id']).toBe('string');
    expect(logger.assign).toHaveBeenCalledWith({
      requestId: mockRequest.headers?.['x-request-id'],
    });
    expect(mockNext).toHaveBeenCalled();
  });

  it('should forward existing requestId', () => {
    const existingId = 'existing-request-id';
    mockRequest.headers = { 'x-request-id': existingId };

    middleware.use(
      mockRequest as Request,
      mockResponse as Response,
      mockNext,
    );

    expect(mockRequest.headers['x-request-id']).toBe(existingId);
    expect(logger.assign).toHaveBeenCalledWith({ requestId: existingId });
    expect(mockNext).toHaveBeenCalled();
  });
});

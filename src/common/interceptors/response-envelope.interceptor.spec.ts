import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor.js';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { NO_ENVELOPE_KEY } from '../decorators/no-envelope.decorator.js';

describe('ResponseEnvelopeInterceptor', () => {
  let interceptor: ResponseEnvelopeInterceptor<any>;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    interceptor = new ResponseEnvelopeInterceptor(reflector);
  });

  it('should wrap response in envelope', async () => {
    const mockContext = createMockContext('test-request-id', false);
    const mockHandler = {
      handle: () => of({ result: 'test data' }),
    } as CallHandler;

    const result = await interceptor
      .intercept(mockContext, mockHandler)
      .toPromise();

    expect(result).toEqual({
      data: { result: 'test data' },
      meta: {},
      requestId: 'test-request-id',
    });
  });

  it('should not wrap when NoEnvelope decorator is present', async () => {
    const mockContext = createMockContext('test-request-id', true);
    const mockHandler = {
      handle: () => of({ result: 'raw data' }),
    } as CallHandler;

    const result = await interceptor
      .intercept(mockContext, mockHandler)
      .toPromise();

    expect(result).toEqual({ result: 'raw data' });
  });

  it('should handle missing requestId gracefully', async () => {
    const mockContext = createMockContext('', false);
    const mockHandler = {
      handle: () => of({ result: 'test data' }),
    } as CallHandler;

    const result = await interceptor
      .intercept(mockContext, mockHandler)
      .toPromise();

    expect(result).toEqual({
      data: { result: 'test data' },
      meta: {},
      requestId: '',
    });
  });

  function createMockContext(
    requestId: string,
    noEnvelope: boolean,
  ): ExecutionContext {
    const mockRequest = {
      headers: { 'x-request-id': requestId },
    };

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as ExecutionContext;

    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(noEnvelope);

    return mockContext;
  }
});

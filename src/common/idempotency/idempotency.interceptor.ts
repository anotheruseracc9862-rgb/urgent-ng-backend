import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, throwError, of, from } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { IdempotencyService, IdempotencyConflictError } from './idempotency.service.js';
import { IDEMPOTENT_KEY, IdempotentOptions } from './idempotent.decorator.js';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const options = this.reflector.get<IdempotentOptions>(
      IDEMPOTENT_KEY,
      context.getHandler(),
    );

    // If no @Idempotent decorator, pass through
    if (!options) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const idempotencyKey = request.headers['idempotency-key'];

    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw new BadRequestException(
        'Idempotency-Key header is required for this operation',
      );
    }

    // Extract userId (always required for now; extend if needed)
    const userId = request.user?.id;
    if (!userId) {
      throw new BadRequestException('User authentication required');
    }

    const { operation } = options;
    const requestBody = request.body;

    // Check if this key was already processed
    try {
      const existing = await this.idempotencyService.check(
        userId,
        operation,
        idempotencyKey,
        requestBody,
      );

      if (existing) {
        // Return cached response if available
        if (existing.responseStatus !== null && existing.responseBody !== null) {
          const response = context.switchToHttp().getResponse();
          response.status(existing.responseStatus);
          return of(existing.responseBody);
        }

        // Still processing (responseStatus is null)
        throw new ConflictException(
          'Request with this idempotency key is currently being processed',
        );
      }
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }

    // Store new idempotency record
    const stored = await this.idempotencyService.store(
      userId,
      operation,
      idempotencyKey,
      requestBody,
    );

    if (!stored) {
      // Race condition: another request stored it first
      throw new ConflictException(
        'Request with this idempotency key is currently being processed',
      );
    }

    // Process the request and store the response
    return next.handle().pipe(
      mergeMap((data) => {
        const response = context.switchToHttp().getResponse();
        const statusCode = response.statusCode || 200;

        return from(
          this.idempotencyService.updateResponse(
            userId,
            operation,
            idempotencyKey,
            statusCode,
            data,
          ),
        ).pipe(
          mergeMap(() => of(data)),
        );
      }),
      catchError((error) => {
        // On error, leave the idempotency key without a response
        // so it can be retried (will expire after TTL)
        return throwError(() => error);
      }),
    );
  }
}

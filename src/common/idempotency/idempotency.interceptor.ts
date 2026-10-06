import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  RequestMethod,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, defer, from, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { IdempotencyConflictError, IdempotencyService } from './idempotency.service.js';
import { IDEMPOTENT_KEY, IdempotentOptions } from './idempotent.decorator.js';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const HTTP_CODE_METADATA = '__httpCode__';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(
      IDEMPOTENT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!options) {
      return next.handle();
    }

    return defer(() => from(this.run(context, next, options))).pipe(
      mergeMap((result) => result),
    );
  }

  private async run(
    context: ExecutionContext,
    next: CallHandler,
    options: IdempotentOptions,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    const header = request.headers['idempotency-key'];
    if (typeof header !== 'string' || !KEY_PATTERN.test(header)) {
      throw new BadRequestException(
        'Idempotency-Key header is required (8 to 128 characters: letters, digits, . _ : -)',
      );
    }

    const userId: string | undefined = request.user?.id;
    if (!userId) {
      throw new BadRequestException('User authentication required');
    }

    const { operation } = options;
    const key = header;
    const body = request.body;

    try {
      const existing = await this.idempotencyService.check(userId, operation, key, body);
      if (existing) {
        if (existing.responseStatus !== null) {
          response.status(existing.responseStatus);
          return of(existing.responseBody);
        }
        if (!existing.failed) {
          throw new ConflictException(
            'Request with this idempotency key is currently being processed',
          );
        }
        // failed earlier: fall through and claim it again
      }
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }

    const stored = await this.idempotencyService.store(userId, operation, key, body);
    if (!stored) {
      throw new ConflictException(
        'Request with this idempotency key is currently being processed',
      );
    }

    const status = this.successStatus(context, request.method);

    return next.handle().pipe(
      mergeMap((data) =>
        from(
          this.idempotencyService.updateResponse(userId, operation, key, status, data),
        ).pipe(mergeMap(() => of(data))),
      ),
      catchError((error) =>
        // Release the key so the client can retry with the same key.
        from(this.idempotencyService.markFailed(userId, operation, key)).pipe(
          mergeMap(() => throwError(() => error)),
          catchError(() => throwError(() => error)),
        ),
      ),
    );
  }

  /**
   * Nest sets the final status after interceptors run, so the response object
   * still shows 200 here. Use @HttpCode when present, else the Nest default
   * (201 for POST, 200 otherwise).
   */
  private successStatus(context: ExecutionContext, method: string): number {
    const explicit = this.reflector.get<number | undefined>(
      HTTP_CODE_METADATA,
      context.getHandler(),
    );
    if (explicit) {
      return explicit;
    }
    return method === 'POST' || method === RequestMethod[RequestMethod.POST] ? 201 : 200;
  }
}

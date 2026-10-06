import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { NO_ENVELOPE_KEY } from '../decorators/no-envelope.decorator.js';

export interface EnvelopedResponse<T> {
  data: T;
  meta: Record<string, unknown>;
  requestId: string;
}

@Injectable()
export class ResponseEnvelopeInterceptor<T>
  implements NestInterceptor<T, EnvelopedResponse<T>>
{
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<EnvelopedResponse<T>> {
    const noEnvelope = this.reflector.getAllAndOverride<boolean>(
      NO_ENVELOPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (noEnvelope) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const requestId = (request.headers['x-request-id'] as string) || '';

    return next.handle().pipe(
      map((data) => ({
        data,
        meta: {},
        requestId,
      })),
    );
  }
}

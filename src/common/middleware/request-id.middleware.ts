import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { resolveRequestId } from './request-id.js';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(private readonly logger: PinoLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = resolveRequestId(req.headers['x-request-id']);

    // Store in headers for downstream use (filters, interceptors)
    req.headers['x-request-id'] = requestId;

    // Echo on the response
    res.setHeader('x-request-id', requestId);

    // Bind to the Pino context
    this.logger.assign({ requestId });

    next();
  }
}

import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(private readonly logger: PinoLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    
    // Store in headers for downstream use
    req.headers['x-request-id'] = requestId;
    
    // Set on response header
    res.setHeader('x-request-id', requestId);
    
    // Bind to Pino context
    this.logger.assign({ requestId });
    
    next();
  }
}

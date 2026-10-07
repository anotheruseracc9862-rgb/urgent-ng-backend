import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RequestContext } from '../auth-audit.service.js';

/** Client IP, user agent and request id, for audit records and sessions. */
export const ReqCtx = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  const request = ctx.switchToHttp().getRequest();
  const userAgent = request.headers['user-agent'];
  const requestId = request.headers['x-request-id'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : undefined,
    requestId: typeof requestId === 'string' ? requestId : undefined,
  };
});

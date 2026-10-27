import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Headers, HttpCode, Post, Query, Req, Res, SetMetadata, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiConsumerAuth, ApiEnveloped } from '../common/api/api-docs.js';
import { NoEnvelope } from '../common/decorators/no-envelope.decorator.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { ALLOWED_STATUSES_KEY, AccountStatusGuard } from '../auth/guards/account-status.guard.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { INTERNAL_ERROR } from '../common/constants/error-codes.js';
import { RealtimeStreamService, type SseFrame } from './realtime-stream.service.js';
import { RealtimeTicketService } from './realtime-ticket.service.js';
import { SseAuthGuard } from './sse-auth.guard.js';
import { EventTicketDto } from './events.dto.js';

const HEARTBEAT_MS = 25_000;

const write = (res: Response, frame: SseFrame): void => {
  if (frame.kind === 'heartbeat') {
    res.write(': ping\n\n');
  } else if (frame.kind === 'resync') {
    res.write(`event: resync\ndata: ${JSON.stringify(frame.envelope)}\n\n`);
  } else {
    res.write(`id: ${frame.id}\ndata: ${JSON.stringify(frame.envelope)}\n\n`);
  }
};

/**
 * Server-sent events (Backend PRD 19.5). Best effort: a missed event is repaired by refetching.
 */
@ApiTags('Realtime')
@Controller('events')
export class EventsController {
  constructor(
    private readonly streams: RealtimeStreamService,
    private readonly tickets: RealtimeTicketService,
    private readonly config: BusinessConfigService,
  ) {}

  /** Issue a one-time ticket for `GET /events?ticket=` (clients that cannot send cookies). */
  @Post('ticket')
  @HttpCode(200)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(EventTicketDto)
  ticket(@CurrentUser() user: AuthenticatedUser): EventTicketDto {
    return this.tickets.issue(user.userId);
  }

  @Get()
  @ApiResponse({
    status: 200,
    description:
      'A text/event-stream. Each frame is `id: <stream id>` and `data: <envelope JSON>`; a `resync` event means refetch current state; `: ping` comments are heartbeats. Resume with the Last-Event-ID header.',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @NoEnvelope()
  @SetMetadata(ALLOWED_STATUSES_KEY, [])
  @UseGuards(SseAuthGuard, AccountStatusGuard)
  async stream(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Query('lastEventId') lastEventIdQuery: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const max = await this.config.get('REALTIME_MAX_CONNECTIONS_PER_USER');
    const slot = await this.streams.acquireSlot(user.userId, max);

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    req.on('aborted', () => abort.abort());

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    try {
      for await (const frame of this.streams.frames(user.userId, lastEventId || lastEventIdQuery || undefined, abort.signal, { heartbeatMs: HEARTBEAT_MS })) {
        write(res, frame);
        if (frame.kind === 'heartbeat') {
          // The slot is gone when a newer connection took it over the cap: end this one.
          const kept = await this.streams.refreshSlot(user.userId, slot);
          if (!kept) break;
        }
      }
    } catch {
      if (!abort.signal.aborted) {
        // The stream is unavailable (Redis down). Tell the client to come back and refetch.
        res.write(`event: error\ndata: ${JSON.stringify({ code: INTERNAL_ERROR })}\n\n`);
      }
    } finally {
      await this.streams.releaseSlot(user.userId, slot);
      res.end();
    }
  }
}

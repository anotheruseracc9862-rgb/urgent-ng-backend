import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { ChangeRequestService } from './change-request.service.js';
import { ChangeRequestDto, CreateChangeRequestDto } from './change-request.dto.js';

/** Change requests after acceptance (Backend PRD 15.6, 30.6). */
@ApiTags('Change requests')
@Controller()
export class ChangeRequestController {
  constructor(private readonly changes: ChangeRequestService) {}

  @Post('assignments/:id/change-requests')
  @Idempotent({ operation: 'change-request-create' })
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ChangeRequestDto, { status: 201 })
  @ApiErrors(400, 404, 409)
  create(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateChangeRequestDto) {
    return this.changes.create(user.userId, id, dto);
  }

  @Get('assignments/:id/change-requests')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ChangeRequestDto, { isArray: true })
  @ApiErrors(404)
  list(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.changes.list(user.userId, id);
  }

  @Post('change-requests/:id/accept')
  @HttpCode(200)
  @Idempotent({ operation: 'change-request-accept' })
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ChangeRequestDto)
  @ApiErrors(403, 404, 409)
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.changes.accept(user.userId, id);
  }

  @Post('change-requests/:id/reject')
  @HttpCode(200)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ChangeRequestDto)
  @ApiErrors(403, 404, 409)
  reject(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.changes.reject(user.userId, id);
  }

  @Post('change-requests/:id/cancel')
  @HttpCode(200)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(ChangeRequestDto)
  @ApiErrors(403, 404, 409)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.changes.cancel(user.userId, id);
  }
}

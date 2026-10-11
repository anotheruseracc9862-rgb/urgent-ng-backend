import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { DisputeService } from './dispute.service.js';
import { DisputeDto, EvidenceItemDto, OpenDisputeDto } from './dispute.dto.js';

/** Disputes (Backend PRD 21.3, 30.7). Only the two parties of the assignment reach a dispute. */
@ApiTags('Disputes')
@Controller()
export class DisputesController {
  constructor(private readonly disputes: DisputeService) {}

  @Post('assignments/:id/disputes')
  @Idempotent({ operation: 'dispute-open' })
  @ConsumerAuth({ allow: ['DEACTIVATED'], continueWhenSuspended: true })
  @ApiConsumerAuth()
  @ApiEnveloped(DisputeDto, { status: 201 })
  @ApiErrors(400, 404, 409)
  open(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OpenDisputeDto) {
    return this.disputes.open(user.userId, id, dto);
  }

  @Get('disputes/:id')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(DisputeDto)
  @ApiErrors(404)
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.disputes.get(user.userId, id);
  }

  @Post('disputes/:id/evidence')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(DisputeDto, { status: 201 })
  @ApiErrors(400, 404, 409)
  addEvidence(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EvidenceItemDto) {
    return this.disputes.addEvidence(user.userId, id, dto);
  }
}

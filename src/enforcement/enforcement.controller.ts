import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { EnforcementService } from './enforcement.service.js';
import { AppealDto, EnforcementActionDto } from './enforcement.dto.js';

/**
 * Account standing (Backend PRD 21.4). A user always sees what was done to their account and why,
 * and can appeal, including while suspended or deactivated.
 */
@ApiTags('Enforcement')
@Controller()
export class EnforcementController {
  constructor(private readonly enforcement: EnforcementService) {}

  @Get('me/enforcement')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] })
  @ApiConsumerAuth()
  @ApiEnveloped(EnforcementActionDto, { isArray: true })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.enforcement.listForUser(user.userId);
  }

  @Post('enforcement/:id/appeal')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] })
  @ApiConsumerAuth()
  @ApiEnveloped(EnforcementActionDto, { status: 201 })
  @ApiErrors(400, 404, 409)
  appeal(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AppealDto) {
    return this.enforcement.requestAppeal(user.userId, id, dto.note);
  }
}

import { ApiTags } from '@nestjs/swagger';
import { Controller, Get } from '@nestjs/common';
import { ApiEnveloped, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { DashboardService } from './dashboard.service.js';
import { MeSummaryDto } from './dashboard.dto.js';

@ApiTags('Me')
@Controller('me/summary')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** The figures and the latest activity for both dashboards, in one call. */
  @Get()
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(MeSummaryDto)
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboard.summary(user.userId);
  }
}

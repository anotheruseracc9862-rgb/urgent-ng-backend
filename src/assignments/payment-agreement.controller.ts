import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { PaymentAgreementService } from './payment-agreement.service.js';
import { PaymentAgreementDto, UpdatePaymentAgreementDto } from './payment-agreement.dto.js';

/** Payment agreement (Backend PRD 16.1, 30.6). Urgent.ng records what was agreed; it never processes the payment. */
@ApiTags('Assignments')
@Controller('assignments/:id/payment-agreement')
export class PaymentAgreementController {
  constructor(private readonly agreements: PaymentAgreementService) {}

  @Get()
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(PaymentAgreementDto)
  @ApiErrors(404)
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.agreements.get(user.userId, id);
  }

  @Put()
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(PaymentAgreementDto)
  @ApiErrors(400, 404, 409)
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePaymentAgreementDto) {
    return this.agreements.update(user.userId, id, dto);
  }
}

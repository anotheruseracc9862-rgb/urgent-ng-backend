import { Module } from '@nestjs/common';
import { NegotiationService } from './negotiation.service.js';

@Module({
  providers: [NegotiationService],
  exports: [NegotiationService],
})
export class NegotiationsModule {}
